// DeepSeek 獨立驗收：擴充套件 0.4.0「選詞旁小窗（anchored popup）＋快速收藏」。
//
// 真 MV3：真 Chromium 載入 extension/、真 Worker 路由＋SQLite（tests/helpers/extension-mv3.cjs），
// 只有 AI transport 是 mock。受測檔見 TESTED_FILES（報告附每個檔案的 sha256 前 16 碼）。
//
// 驗收範圍（對應 docs/research/20261106153234466 的 Q1–Q7 與 docs/plan/20261106155022443）：
//   A. 交付與打包前置（ready 標記、新 DOM／新訊息通道、真 MV3、帳戶可連）
//   B. 小窗基線：真點擊查詞才開卡、實際 iframe 框靠近選詞、寬約 340、高度小、緊湊內容正確
//   C. 視窗四邊：上下翻轉與左右夾限，卡片完整留在視窗內並仍貼著選詞
//   D. 多行短語：按整個選區（union）定位，寬高仍符合小窗
//   E. 捲動：頁面捲動與容器捲動都跟隨；選詞離開可視範圍就收起
//   F. 關閉：外部點擊／頁面 Esc／卡內 Esc 收起；卡內點擊不誤關；換新詞點查詞只換同一個小窗
//   G. 「更多」展開同一 iframe 完整面板並保留結果，返回小窗不重跑 AI
//   H. 編輯固定：busy／dirty 不自動關閉；明確關閉有草稿需確認（保留／放棄）
//   I. 快速收藏：無目標時一鍵建立本頁詞書並加入當前結果；同頁選擇→頁書→明確預設的沿用次序
//      （I11–I17：0 本詞書帳號的空狀態提示——兩語皆引導「在此新建」、不再叫人先回 BDC，
//       文字取自字典而非硬編碼，且「建立本頁詞書並加入」真的可用）
//   J. 收藏失敗不得假成功；重試不多建（含「伺服器已套用但回應遺失」）
//   K. 網頁偽造訊息（帶真 ticket）不得 resize／expand／close／開卡／寫入
//   L. 票據與憑證不得經 window message 洩漏
//   M. 遲到回應：先 A 後 B 只留一個小窗，B 的結果不被 A 遲到的回應蓋掉
//   N. 兩語（zh-CN／zh-HK）窄視窗：寬度、無橫向溢出、展開後高度夾限
//   O. 帳戶隔離：切換帳戶後新小窗不沿用上一個帳戶的詞書，也不寫錯帳戶
//
// 用法：
//   PLAYWRIGHT_MODULE=<playwright> node tests/extension-anchored-popup-deepseek.cjs
//   PLAYWRIGHT_MODULE=<playwright> node tests/extension-anchored-popup-deepseek.cjs --full
//
// 交付閘門：預設只有 docs/report/assets/anchored-popup-ready.json 存在（且靜態契約齊備）才跑完整驗收；
// 否則只做「能力探針」（preflight），列出缺少哪一項並以 0 結束——產品未完成不算故障。
// --full 會跳過閘門直接跑完整驗收（供獨立驗收／除錯用）。
//
// 幾何量測：卡片是 closed shadow root 內的 iframe，用 frame.frameElement().boundingBox() 讀實際框；
// 浮動「查詞」按鈕同樣在 closed shadow root 內，用 CDP DOM.getDocument(pierce) + DOM.getBoxModel 取得真實框後真點擊。
//
// 所有帳號與資料由測試自建；不連正式 Worker／正式 AI／正式 D1、不讀私有 ai-config.js。
// 輸出寫到 docs/report/assets/<時間戳>_anchored-popup-deepseek/。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { environment, ALICE, BOB } = require('./helpers/extension-mv3.cjs');

const ROOT = path.resolve(__dirname, '..');
const stamp = new Date(Date.now() + 8 * 3600000).toISOString().replace(/\D/g, '').slice(0, 17);
const OUT = process.env.ANCHORED_POPUP_OUTPUT || path.join(ROOT, 'docs/report/assets', stamp + '_anchored-popup-deepseek');
const READY_MARKER = path.join(ROOT, 'docs/report/assets/anchored-popup-ready.json');

// 使用者指定的 UI 契約（產品實作時必須具備）。
const REQUIRED_IDS = ['ext-inline-more', 'ext-inline-back', 'ext-inline-confirm', 'ext-inline-discard', 'ext-inline-keep', 'ext-quick-capture'];
const REQUIRED_BODY_CLASSES = ['ext-compact', 'ext-expanded'];
const REQUIRED_MESSAGES = ['BDC_INLINE_STATE', 'BDC_INLINE_REMOVE', 'BDC_INLINE_KEEP', 'BDC_INLINE_REQUEST_CLOSE'];
const TARGET_WIDTH = 340;
const SUCCESS_TEXT = /已加入/;
const PENDING_TEXT = /待傳|待传|尚未確認|尚未确认/;
const PAGE_TITLE = 'Major tech stocks plunge';

const TESTED_FILES = [
    'extension/manifest.json', 'extension/background.js', 'extension/page-lookup.js', 'extension/inline-panel.js',
    'extension/lookup.html', 'extension/lookup.js', 'extension/lookup.css', 'extension/capture-ui.js',
    'extension/workspace-ui.js', 'extension/selection-extractor.js', 'extension/page-extractor.js',
    'extension/modules/extension-workspace.js', 'extension/modules/extension-ai-runtime.js',
    'modules/extension-workspace.js', 'shared/workspace-client.mjs', 'shared/capture-client.mjs',
    'shared/capture-protocol.mjs', 'shared/page-protocol.mjs',
    'cloudflare-worker/src/captures.js', 'cloudflare-worker/src/capture-books.js',
    'locales/zh-CN.js', 'locales/zh-HK.js',
    'scripts/package-extension.mjs', 'tests/helpers/extension-mv3.cjs',
    'tests/extension-anchored-popup-deepseek.cjs'
];

const checks = [];
const notes = [];
function check(name, condition, detail) {
    checks.push({ name, ok: !!condition, ...(detail === undefined ? {} : { detail }) });
    console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${condition || detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
    return !!condition;
}
function note(name, value) {
    notes.push({ name, value });
    console.log(`NOTE ${name}: ${JSON.stringify(value)}`);
}
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function productHashes() {
    return Object.fromEntries(TESTED_FILES.map((file) => {
        const absolute = path.join(ROOT, file);
        if (!fs.existsSync(absolute)) return [file, { missing: true }];
        const stat = fs.statSync(absolute);
        return [file, {
            sha256_16: createHash('sha256').update(fs.readFileSync(absolute)).digest('hex').slice(0, 16),
            mtime: new Date(stat.mtimeMs + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19),
            bytes: stat.size
        }];
    }));
}
function readyMarkerPresent() {
    return fs.existsSync(READY_MARKER);
}

/* ------------------------------------------------------------------ *
 * 交付閘門：靜態能力探針（不需要瀏覽器）
 * ------------------------------------------------------------------ */
function staticReadiness() {
    const read = (rel) => {
        const absolute = path.join(ROOT, rel);
        return fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : '';
    };
    const html = read('extension/lookup.html');
    const css = read('extension/lookup.css') + read('styles.css');
    const background = read('extension/background.js');
    const lookup = read('extension/lookup.js');
    const panel = read('extension/inline-panel.js');
    const combined = lookup + panel;
    let version = '';
    try { version = JSON.parse(read('extension/manifest.json')).version || ''; } catch (_) { version = ''; }
    const missing = [];
    const present = { 'extension/inline-panel.js': !!panel };
    if (!panel) missing.push('extension/inline-panel.js 不存在');
    for (const id of REQUIRED_IDS) {
        const found = new RegExp(`id=["']${id}["']`).test(html) || combined.includes(id);
        present['#' + id] = found;
        if (!found) missing.push(`缺少 #${id}`);
    }
    for (const cls of REQUIRED_BODY_CLASSES) {
        const found = css.includes('.' + cls) || combined.includes(cls);
        present['body .' + cls] = found;
        if (!found) missing.push(`缺少 body .${cls}`);
    }
    for (const type of REQUIRED_MESSAGES) {
        const found = background.includes(type) || combined.includes(type);
        present[type] = found;
        if (!found) missing.push(`未見 ${type} 中繼`);
    }
    present['manifest.version'] = version;
    const versionOk = /^0\.4\./.test(version);
    if (!versionOk) missing.push(`manifest version 仍為 ${version || '(無法解析)'}`);
    return { missing, present, version, versionOk };
}

/* ------------------------------------------------------------------ *
 * 瀏覽器與卡片工具
 * ------------------------------------------------------------------ */
async function waitUntil(predicate, { timeout = 6000, interval = 100 } = {}) {
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
async function waitForPanelGone(page, base, timeout = 10000) {
    return !!(await waitUntil(() => livePanels(page, base).length === 0, { timeout }));
}
async function panelTicket(frame) {
    try { return new URL(frame.url()).searchParams.get('ticket') || ''; } catch (_) { return ''; }
}
async function panelBox(frame) {
    try {
        const element = await frame.frameElement();
        if (!element) return null;
        return await element.boundingBox();
    } catch (_) { return null; }
}

// closed shadow root 內的按鈕只能用 CDP 的 flattened document（pierce）取得真實框。
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
        const model = await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId }).then((result) => result.model).catch(() => null);
        if (!model || model.width < 20 || model.height < 16) continue;
        visible.push({
            center: {
                x: (model.border[0] + model.border[2] + model.border[4] + model.border[6]) / 4,
                y: (model.border[1] + model.border[3] + model.border[5] + model.border[7]) / 4
            },
            box: { x: model.border[0], y: model.border[1], width: model.width, height: model.height }
        });
    }
    return visible;
}
async function clickLookupButton(page, cdp, selectionRect) {
    const buttons = await shellButtons(cdp);
    if (!buttons.length) return null;
    const anchorX = selectionRect.x + Math.min(selectionRect.width / 2, 40);
    const anchorY = selectionRect.y + selectionRect.height + 18;
    const chosen = buttons
        .map((button) => ({ ...button, distance: Math.hypot(button.center.x - anchorX, button.center.y - anchorY) }))
        .sort((left, right) => left.distance - right.distance)[0];
    await page.mouse.click(chosen.center.x, chosen.center.y);
    return chosen;
}

async function selectionInfo(page, { word, occurrence = 0 }) {
    return page.evaluate(({ word: needle, occurrence: wanted }) => {
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
        let seen = 0;
        let node;
        while ((node = walker.nextNode())) {
            const text = node.textContent || '';
            let from = 0;
            let index;
            while ((index = text.indexOf(needle, from)) !== -1) {
                const range = document.createRange();
                range.setStart(node, index);
                range.setEnd(node, index + needle.length);
                const rects = Array.from(range.getClientRects())
                    .map((rect) => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }))
                    .filter((rect) => rect.width > 0 && rect.height > 0);
                // <title> 之類不渲染的文字也會命中：沒有實際矩形就不算一次選取。
                if (rects.length) {
                    if (seen === wanted) {
                        const union = range.getBoundingClientRect();
                        return {
                            rects,
                            rect: { x: union.x, y: union.y, width: union.width, height: union.height },
                            text: normalize(range.toString())
                        };
                    }
                    seen += 1;
                }
                from = index + needle.length;
            }
        }
        return null;
    }, { word, occurrence });
}
async function selectByWord(page, options) {
    const info = await selectionInfo(page, options);
    if (!info || !info.rects.length) return null;
    const first = info.rects[0];
    const last = info.rects[info.rects.length - 1];
    await page.mouse.move(first.x + 1, first.y + first.height / 2);
    await page.mouse.down();
    await page.mouse.move(last.x + Math.max(1, last.width - 1), last.y + last.height / 2, { steps: 12 });
    await page.mouse.up();
    info.selected = await page.evaluate(() => String(getSelection()?.toString() || '').replace(/\s+/g, ' ').trim());
    return info;
}

// 卡片狀態快照：全部用使用者指定的 ids＋可見性判斷，不依賴實作細節。
async function frameState(frame) {
    return frame.evaluate(() => {
        const element = (id) => document.getElementById(id);
        const visible = (id) => {
            const node = element(id);
            if (!node) return false;
            if (node.hidden) return false;
            const style = getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
            return node.getClientRects().length > 0;
        };
        const text = (id) => (element(id)?.textContent || '').trim();
        const select = element('ext-capture-book');
        return {
            classes: [...document.body.classList],
            compact: document.body.classList.contains('ext-compact'),
            expanded: document.body.classList.contains('ext-expanded'),
            needsBook: document.body.classList.contains('ext-needs-book'),
            word: text('ext-result-word'),
            phonetic: text('ext-result-phonetic'),
            pos: text('ext-result-pos'),
            meaning: text('ext-result-meaning'),
            more: visible('ext-inline-more'),
            moreLabel: text('ext-inline-more'),
            back: visible('ext-inline-back'),
            backLabel: text('ext-inline-back'),
            close: visible('ext-inline-close'),
            confirm: visible('ext-inline-confirm'),
            keep: visible('ext-inline-keep'),
            discard: visible('ext-inline-discard'),
            quickCapture: visible('ext-quick-capture'),
            quickCaptureLabel: text('ext-quick-capture'),
            captureSave: visible('ext-capture-save'),
            captureSaveLabel: text('ext-capture-save'),
            captureBookVisible: visible('ext-capture-book'),
            captureBookValue: select?.value || '',
            captureBookName: select?.selectedOptions?.[0]?.textContent?.trim() || '',
            captureBookOptions: [...(select?.options || [])].map((option) => option.textContent.trim()).filter(Boolean),
            articleExtract: visible('ext-article-extract'),
            bookPage: visible('ext-book-page'),
            articleBody: element('ext-article-body')?.value || '',
            captureNotice: text('ext-capture-notice'),
            captureNoticeError: !!element('ext-capture-notice')?.classList.contains('ext-notice-error'),
            // 空詞書提示走「下拉佔位文字＋提示列＋一鍵建書按鈕」三處，全部讀實際 DOM。
            captureNoticeHidden: element('ext-capture-notice')?.hidden !== false,
            captureBookPlaceholder: (select?.options?.[0]?.textContent || '').trim(),
            captureHint: text('ext-capture-hint'),
            captureHintHidden: element('ext-capture-hint')?.hidden !== false,
            // 收藏區自己的可見文字（不含外殼工具列的「BDC 網頁查詞」品牌字樣），用來掃 BDC／舊引導。
            captureSectionText: (element('ext-capture-section')?.innerText || '').replace(/\s+/g, ' ').trim(),
            capturePendingVisible: visible('ext-capture-pending'),
            capturePendingItems: document.querySelectorAll('#ext-capture-pending-list li').length,
            inlineNotice: text('ext-inline-lookup-notice'),
            bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1500),
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            contentWidth: document.documentElement.scrollWidth,
            contentHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
            accountStatus: text('ext-account-status'),
            inline: document.body.classList.contains('ext-inline')
        };
    }).catch((error) => ({ error: String((error && error.message) || error) }));
}
async function waitForResult(frame, timeout = 45000) {
    return !!(await waitUntil(async () => {
        if (!frame || frame.isDetached()) return false;
        const state = await frameState(frame);
        return !!(state && state.word && state.meaning);
    }, { timeout }));
}

function anchored(box, selection) {
    const below = box.y >= selection.y + selection.height - 3;
    const above = box.y + box.height <= selection.y + 3;
    const gap = below ? box.y - (selection.y + selection.height) : selection.y - (box.y + box.height);
    return { below, above, gap };
}
function horizontalOverlap(box, selection) {
    return Math.min(box.x + box.width, selection.x + selection.width) - Math.max(box.x, selection.x);
}
function insideViewport(box, viewport, margin = 0) {
    return box.x >= -1 + margin && box.y >= -1 + margin
        && box.x + box.width <= viewport.width + 1 - margin
        && box.y + box.height <= viewport.height + 1 - margin;
}
const round = (value) => Math.round(value * 10) / 10;
const summarizeBox = (box) => (box ? { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) } : null);

/* ------------------------------------------------------------------ *
 * 頁面準備
 * ------------------------------------------------------------------ */
async function prepareArticle(page, env, query) {
    await page.goto(env.base + '/test-article?' + query);
    await page.waitForFunction(() => !!document.querySelector('#article'));
    await page.bringToFront();
    await page.evaluate(() => document.querySelector('#article').scrollIntoView({ block: 'center' }));
    await sleep(120);
}
// 四邊與多行短語用的 fixed 定位探針（座標由測試決定，不受頁面捲動影響）。
async function installEdgeProbes(page) {
    await page.evaluate(() => {
        document.getElementById('ds-probes')?.remove();
        const wrap = document.createElement('div');
        wrap.id = 'ds-probes';
        const add = (id, css, text) => {
            const node = document.createElement('div');
            node.id = id;
            node.textContent = text;
            node.style.cssText = 'position:fixed;font:16px/22px monospace;background:#fff;color:#111;padding:1px 2px;'
                + 'border:0;z-index:2147483000;' + css;
            wrap.appendChild(node);
        };
        add('ds-top', 'top:6px;left:140px', 'alphaword');
        add('ds-bottom', 'bottom:36px;left:140px', 'omegaword');
        add('ds-left', 'top:250px;left:0', 'leftword');
        add('ds-right', 'top:330px;right:0', 'rightword');
        add('ds-multi', 'top:420px;left:180px;width:150px;white-space:normal', 'worry about markets');
        (document.body || document.documentElement).appendChild(wrap);
    });
    return waitUntil(() => page.evaluate(() => ['ds-top', 'ds-bottom', 'ds-left', 'ds-right', 'ds-multi']
        .every((id) => !!document.getElementById(id))), { timeout: 4000 });
}
// 捲動用的正常流探針（頁面捲動、容器捲動都要有真實可捲動的祖先）。
async function installScrollProbes(page) {
    await page.evaluate(() => {
        document.getElementById('ds-scroll')?.remove();
        const holder = document.createElement('div');
        holder.id = 'ds-scroll';
        holder.style.cssText = 'display:block;padding:8px;font:16px/22px monospace;color:#111;background:#fff;';
        const container = document.createElement('div');
        container.id = 'ds-container';
        container.style.cssText = 'height:120px;width:320px;overflow:auto;border:1px solid #333;background:#fff;';
        const target = document.createElement('p');
        target.id = 'ds-container-line';
        target.textContent = 'containerword alpha beta';
        target.style.cssText = 'margin:0;padding:24px 4px 0;';
        container.appendChild(target);
        for (let index = 0; index < 24; index += 1) {
            const line = document.createElement('p');
            line.textContent = 'container filler ' + index;
            line.style.cssText = 'margin:0;padding:4px;';
            container.appendChild(line);
        }
        holder.appendChild(container);
        const flow = document.createElement('p');
        flow.id = 'ds-flow-target';
        flow.textContent = 'scrollword beta gamma';
        flow.style.cssText = 'margin:24px 0;';
        holder.appendChild(flow);
        const filler = document.createElement('div');
        for (let index = 0; index < 90; index += 1) {
            const line = document.createElement('p');
            line.textContent = 'page filler paragraph ' + index;
            line.style.cssText = 'margin:0;height:40px;';
            filler.appendChild(line);
        }
        holder.appendChild(filler);
        document.body.appendChild(holder);
    });
    return waitUntil(() => page.evaluate(() => !!document.getElementById('ds-container')), { timeout: 4000 });
}

/* ------------------------------------------------------------------ *
 * DB 事實核對（只用於事前 fixture 與事後事實）
 * ------------------------------------------------------------------ */
function dbBooks(env, owner = 'alice') {
    return env.db.prepare("SELECT entity_id, deleted_at, data_json FROM reading_entities WHERE owner_user_id=? AND entity_type='vocabularyBook'").all(owner)
        .map((row) => ({ id: row.entity_id, deleted: !!row.deleted_at, ...JSON.parse(row.data_json || '{}') }));
}
function dbEntries(env, owner = 'alice') {
    return env.db.prepare("SELECT entity_id, revision, deleted_at, data_json FROM reading_entities WHERE owner_user_id=? AND entity_type='vocabularyEntry'").all(owner)
        .map((row) => ({ id: row.entity_id, revision: Number(row.revision), deleted: !!row.deleted_at, ...JSON.parse(row.data_json || '{}') }));
}
function dbEntriesFor(env, owner, bookId, word) {
    const key = (value) => String(value || '').trim().toLowerCase();
    return dbEntries(env, owner).filter((entry) => entry.bookId === bookId && !entry.deleted && key(entry.word) === key(word));
}
function dbBookByPage(env, owner, pageUrl) {
    const [pathPart, search = ''] = String(pageUrl || '').split('?');
    return dbBooks(env, owner).find((book) => !book.deleted && book.sourceUrl
        && book.sourceUrl.split('?')[0] === pathPart && (!search || book.sourceUrl.includes(search.split('&')[0])));
}
function dbCaptureRows(env, owner = 'alice') {
    return env.db.prepare('SELECT request_id, result_json FROM vocabulary_captures WHERE owner_user_id=?').all(owner);
}

/* ------------------------------------------------------------------ *
 * 空詞書提示（本輪產品只改了 locales 的 extension.captureNoBooks 兩條文字）
 * ------------------------------------------------------------------ */
// 兩語字典直接從產品檔讀，DOM 文字必須與它逐字相同（證明文字來自 t(key)，不是硬編碼）。
async function localeDictionaries() {
    const load = async (name) => (await import(pathToFileURL(path.join(ROOT, 'locales', name)).href)).default;
    const [cn, hk] = await Promise.all([load('zh-CN.js'), load('zh-HK.js')]);
    return { 'zh-CN': cn, 'zh-HK': hk };
}
// 舊文案（「沒有可選詞書，請先在 BDC 建立並同步詞書。」）與其片段：前端任何一處殘留都算不合格。
const EMPTY_BOOK_STALE_FRAGMENTS = ['没有可选词书', '沒有可選詞書', '请先在 BDC', '請先在 BDC'];
// 前端（擴充套件）不得自己寫死這兩條文字；它們只能經 t('extension.captureNoBooks') 取得。
const EMPTY_BOOK_FRONT_FILES = [
    'extension/capture-ui.js', 'extension/inline-panel.js', 'extension/lookup.js',
    'extension/workspace-ui.js', 'extension/lookup.html'
];
const EMPTY_BOOK_LITERALS = ['暂无词书', '暫無詞書', '可直接在此新建', '可直接在此新增'];
function frontEndHardcodedEmptyBook() {
    const hits = [];
    for (const file of EMPTY_BOOK_FRONT_FILES) {
        const absolute = path.join(ROOT, file);
        if (!fs.existsSync(absolute)) { hits.push({ file, literal: '(檔案不存在)' }); continue; }
        const source = fs.readFileSync(absolute, 'utf8');
        for (const literal of [...EMPTY_BOOK_LITERALS, ...EMPTY_BOOK_STALE_FRAGMENTS]) {
            if (source.includes(literal)) hits.push({ file, literal });
        }
    }
    return hits;
}
const fileHash = (rel) => createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');

/* ------------------------------------------------------------------ *
 * preflight（未 ready 時只做能力探針，不當成故障）
 * ------------------------------------------------------------------ */
async function preflight(readiness) {
    const summary = {
        mode: 'preflight',
        readyMarker: readyMarkerPresent() ? READY_MARKER : null,
        static: readiness.present,
        missing: readiness.missing
    };
    let packaging = { ok: false };
    try {
        const output = execFileSync(process.execPath, ['scripts/package-extension.mjs'], { cwd: ROOT, encoding: 'utf8' });
        packaging = { ok: true, output: output.trim() };
    } catch (error) {
        packaging = { ok: false, error: String(error.stderr || error.message).trim().split('\n').slice(-4).join(' | ') };
    }
    summary.packaging = packaging;
    let harness = { attempted: false };
    if (packaging.ok) {
        const probeOut = path.join(OUT, 'preflight');
        fs.mkdirSync(probeOut, { recursive: true });
        const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-anchor-pre-'));
        let env;
        let context;
        try {
            env = await environment();
            const extension = path.join(ROOT, 'extension');
            context = await chromium.launchPersistentContext(profile, {
                channel: 'chromium', headless: true, viewport: { width: 1000, height: 760 },
                args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
            });
            const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
            const base = `chrome-extension://${new URL(worker.url()).host}`;
            const popup = await context.newPage();
            await popup.goto(base + '/lookup.html');
            await popup.waitForFunction(() => !!document.querySelector('#ext-account-status').textContent);
            await popup.locator('#ext-endpoint-input').fill(env.base);
            await popup.locator('#ext-login-mode').selectOption('token');
            await popup.locator('#ext-token-input').fill(ALICE);
            await popup.locator('#ext-connect-btn').click();
            await popup.waitForFunction(() => !document.querySelector('#ext-connect-btn').disabled
                && /已连接账户/.test(document.querySelector('#ext-account-status').textContent), null, { timeout: 30000 });
            const page = await context.newPage();
            await prepareArticle(page, env, 'preflight=1');
            const cdp = await context.newCDPSession(page);
            const info = await selectByWord(page, { word: 'plunge' });
            const aiBefore = env.state.aiCalls;
            const button = info ? await clickLookupButton(page, cdp, info.rect) : null;
            const frame = await waitForPanel(page, base, 20000);
            if (frame) await waitForResult(frame, 30000);
            const box = frame ? await panelBox(frame) : null;
            const state = frame ? await frameState(frame) : null;
            harness = {
                attempted: true, selection: summarizeBox(info?.rect || null), button: button?.box || null,
                viewport: page.viewportSize(), panel: summarizeBox(box),
                state: state && {
                    classes: state.classes, word: state.word, meaning: state.meaning,
                    more: state.more, quickCapture: state.quickCapture, expanded: state.expanded, compact: state.compact
                },
                aiCalls: env.state.aiCalls - aiBefore
            };
            if (frame) await page.screenshot({ path: path.join(probeOut, 'preflight-panel.png') });
        } catch (error) {
            harness = { attempted: true, error: String((error && error.stack) || error).slice(0, 1500) };
        } finally {
            if (context) await context.close().catch(() => {});
            if (env) await env.close().catch(() => {});
            fs.rmSync(profile, { recursive: true, force: true });
        }
    }
    summary.harness = harness;
    summary.verdict = !readyMarkerPresent()
        ? '尚未交付：docs/report/assets/anchored-popup-ready.json 不存在；等 Codex 標記 ready 後再跑完整驗收。'
        : (readiness.missing.length ? '已標記 ready 但靜態契約仍缺項，需先補齊。' : '契約齊備，可跑完整驗收。');
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'preflight.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({
        mode: 'preflight', readyMarker: readyMarkerPresent(), missing: readiness.missing,
        packaging: packaging.ok ? 'ok' : packaging.error,
        harness: harness.error ? harness.error : { panel: summarizeBox(harness.panel), state: harness.state },
        verdict: summary.verdict, output: OUT
    }));
    return summary;
}

/* ------------------------------------------------------------------ *
 * 完整驗收
 * ------------------------------------------------------------------ */
async function acceptance() {
    fs.mkdirSync(OUT, { recursive: true });
    execFileSync(process.execPath, ['scripts/package-extension.mjs'], { cwd: ROOT });
    const packagingOk = true;
    const hashes = productHashes();
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-anchor-ds-'));
    let env;
    let context;
    const errors = [];
    const consoles = [];
    const badResponses = [];
    const requestLog = [];
    const shots = [];
    const debug = [];
    let page;
    let popup;
    let base = '';
    let cdp;
    let viewport;
    const screenshot = async (target, name) => {
        await target.screenshot({ path: path.join(OUT, name + '.png') }).then(() => shots.push(name + '.png')).catch(() => {});
    };
    // 卡片是 closed shadow root 內的 iframe：用 frame.frameElement() 的實際框截圖，方便直接看提示文字。
    const panelShot = async (frame, name) => {
        try {
            const element = await frame.frameElement();
            if (!element) return false;
            await element.screenshot({ path: path.join(OUT, name + '.png') });
            shots.push(name + '.png');
            return true;
        } catch (_) { return false; }
    };
    const section = async (name, run) => {
        try { await run(); } catch (error) {
            check(`${name}：區段執行失敗`, false, String((error && error.stack) || error).slice(0, 1500));
            console.error(`[section ${name}]`, (error && error.stack) || error);
        }
    };
    try {
        env = await environment();
        const extension = path.join(ROOT, 'extension');
        context = await chromium.launchPersistentContext(profile, {
            channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 },
            args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
        });
        // 頁面世界訊息稽核：任何 postMessage 進出都留紀錄（洩漏檢查用）。
        await context.addInitScript(() => {
            if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
            window.__bdcPosted = [];
            window.__bdcInbound = [];
            const original = window.postMessage.bind(window);
            window.postMessage = function (data, ...rest) {
                try { window.__bdcPosted.push({ target: String(rest[0] || ''), data: JSON.parse(JSON.stringify(data)) }); }
                catch (_) { window.__bdcPosted.push({ target: '', data: String(data) }); }
                return original(data, ...rest);
            };
            window.addEventListener('message', (event) => {
                try { window.__bdcInbound.push({ origin: event.origin, data: JSON.parse(JSON.stringify(event.data)) }); }
                catch (_) { window.__bdcInbound.push({ origin: event.origin, data: String(event.data) }); }
            });
        });
        context.on('page', (target) => {
            target.on('pageerror', (error) => errors.push({ page: String(target.url()).slice(0, 90), error: error.message }));
            target.on('console', (message) => {
                if (message.type() === 'error') {
                    const location = message.location();
                    consoles.push({ text: message.text(), url: String(location?.url || '').slice(0, 120), page: String(target.url()).slice(0, 90) });
                }
            });
        });
        context.on('response', (response) => {
            if (response.status() >= 400) badResponses.push({ status: response.status(), url: response.url().replace(/ticket=[^&]*/, 'ticket=<redacted>') });
        });
        context.on('request', (request) => {
            const address = request.url();
            if (address.startsWith(env.base)) requestLog.push({ method: request.method(), path: address.slice(env.base.length) });
        });
        const aiRequestsSince = (mark) => requestLog.slice(mark).filter((entry) => entry.path.startsWith('/mock-ai/')).length;
        const writesSince = (mark) => requestLog.slice(mark).filter((entry) => entry.method !== 'GET');

        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        base = `chrome-extension://${new URL(worker.url()).host}`;

        /* ---------------- A. 前置 ---------------- */
        const readiness = staticReadiness();
        await section('A', async () => {
            check('A1 交付標記 docs/report/assets/anchored-popup-ready.json 存在', readyMarkerPresent(), { marker: READY_MARKER });
            check('A2 0.4.0 新 UI ids 齊備（more／back／confirm／discard／keep／quick-capture）',
                REQUIRED_IDS.every((id) => readiness.present['#' + id]), { missing: readiness.missing.filter((item) => item.includes('#')) });
            check('A3 body .ext-compact／.ext-expanded 存在', REQUIRED_BODY_CLASSES.every((cls) => readiness.present['body .' + cls]));
            check('A4 manifest 版本為 0.4.x', readiness.versionOk, { version: readiness.version });
            check('A5 尺寸／模式／關閉以擴充套件內部訊息中繼（不向網頁廣播票據）',
                REQUIRED_MESSAGES.every((type) => readiness.present[type]), { present: readiness.present });
            check('A6 擴充套件可打包並載入（真 MV3）', packagingOk && !!worker && base.startsWith('chrome-extension://'), { packagingOk });
        });

        /* ---------------- 帳戶與頁面 ---------------- */
        popup = await context.newPage();
        await popup.goto(base + '/lookup.html');
        await popup.waitForFunction(() => !!document.querySelector('#ext-account-status').textContent);
        const connect = async (token, who) => {
            await popup.locator('#ext-endpoint-input').fill(env.base);
            await popup.locator('#ext-login-mode').selectOption('token');
            await popup.locator('#ext-token-input').fill(token);
            await popup.locator('#ext-connect-btn').click();
            await popup.waitForFunction((label) => !document.querySelector('#ext-connect-btn').disabled
                && document.querySelector('#ext-account-status').textContent.includes(label), who, { timeout: 30000 });
        };
        await connect(ALICE, 'alice');
        check('A7 可信擴充套件頁面可連上測試帳戶', (await popup.locator('#ext-account-status').textContent()).includes('alice'));

        page = await context.newPage();
        cdp = await context.newCDPSession(page);
        viewport = page.viewportSize();
        await prepareArticle(page, env, 'strict=1');

        const openPopup = async (options) => {
            const info = await selectByWord(page, options);
            if (!info) return { ok: false, reason: 'selection-not-found', options };
            const button = await clickLookupButton(page, cdp, info.rect);
            if (!button) return { ok: false, reason: 'lookup-button-not-found', info };
            const frame = await waitForPanel(page, base);
            if (!frame) return { ok: false, reason: 'panel-not-opened', info, button };
            return { ok: true, info, frame, button };
        };
        const closePopup = async () => {
            if (!livePanels(page, base).length) return true;
            await page.keyboard.press('Escape').catch(() => {});
            if (await waitForPanelGone(page, base, 3000)) return true;
            await page.mouse.click(4, viewport.height - 6).catch(() => {});
            return waitForPanelGone(page, base, 3000);
        };
        // 緊湊卡的收藏入口：沒有目標詞書時是 #ext-quick-capture，有目標時是 #ext-capture-save。
        const captureCurrent = async (frame) => {
            const state = await frameState(frame);
            const selector = state.quickCapture ? '#ext-quick-capture' : (state.captureSave ? '#ext-capture-save' : '');
            if (!selector) return { clicked: false, state };
            const clicked = await frame.locator(selector).click({ timeout: 5000 }).then(() => true).catch(() => false);
            return { clicked, selector, state };
        };
        // 待傳清單包在 <details> 內，先展開才看得到重試／取消。
        const openPendingBox = async (frame) => {
            await frame.evaluate(() => {
                for (const id of ['ext-capture-pending', 'ext-workspace-pending']) {
                    const node = document.getElementById(id);
                    if (node && 'open' in node) node.open = true;
                }
            }).catch(() => {});
            return sleep(150);
        };
        const expandPanel = async (frame) => {
            const state = await frameState(frame);
            if (state.expanded) return true;
            await frame.locator('#ext-inline-more').click({ timeout: 5000 }).catch(() => {});
            return !!(await waitUntil(async () => (await frameState(frame)).expanded === true, { timeout: 8000 }));
        };

        /* ---------------- B. 基線幾何 ---------------- */
        await section('B', async () => {
            const aiBeforeSelect = env.state.aiCalls;
            const selection = await selectByWord(page, { word: 'plunge' });
            check('B1 僅選詞（未點查詞）不開小窗', livePanels(page, base).length === 0);
            check('B2 僅選詞不呼叫 AI（Q1：保留點一下查詞）', env.state.aiCalls === aiBeforeSelect,
                { before: aiBeforeSelect, after: env.state.aiCalls });
            if (!selection) { check('B0 可選到測試詞（前提成立）', false); return; }
            const button = await clickLookupButton(page, cdp, selection.rect);
            check('B3 closed shadow 內有真的浮動查詞按鈕，且框可量測（CDP pierce）', !!button, button?.box || null);
            const frame = await waitForPanel(page, base);
            check('B4 真點擊查詞後才開小窗（嚴格 CSP 網頁也可用）', !!frame);
            if (!frame) return;
            const box = await panelBox(frame);
            check('B5 iframe 實際框可量測（frame.frameElement().boundingBox）', !!box && box.width > 0 && box.height > 0, summarizeBox(box));
            const gotResult = await waitForResult(frame);
            const state = await frameState(frame);
            check('B6 小窗顯示詞、音標、詞性、句中釋義',
                gotResult && state.word === 'plunge' && !!state.phonetic && !!state.pos && /暴跌|急跌/.test(state.meaning || ''),
                { word: state.word, phonetic: state.phonetic, pos: state.pos, meaning: state.meaning });
            check('B7 寬度約 340px（Q4）', !!box && box.width >= TARGET_WIDTH - 10 && box.width <= TARGET_WIDTH + 10,
                { width: round(box?.width || 0), target: TARGET_WIDTH });
            check('B8 高度小（緊湊卡，不是整個視窗高的舊面板）',
                !!box && box.height >= 80 && box.height <= 400 && box.height < viewport.height * 0.62,
                { height: round(box?.height || 0), viewportHeight: viewport.height });
            const anchor = box ? anchored(box, selection.rect) : { below: false, above: false, gap: -1 };
            check('B9 卡片貼近選區（下方為主；間距 ≤ 24px，不足則在上方）',
                (anchor.below || anchor.above) && anchor.gap >= -3 && anchor.gap <= 24,
                { below: anchor.below, above: anchor.above, gap: round(anchor.gap), selection: summarizeBox(selection.rect), box: summarizeBox(box) });
            check('B10 卡片與選區水平有重疊（貼著同一個詞）',
                !!box && horizontalOverlap(box, selection.rect) > 0,
                { overlap: round(box ? horizontalOverlap(box, selection.rect) : -1) });
            check('B11 卡片完整落在視窗內', !!box && insideViewport(box, viewport), summarizeBox(box));
            check('B12 進入緊湊模式（body.ext-compact，不是 .ext-expanded）',
                state.compact === true && state.expanded !== true, { classes: state.classes });
            check('B13 緊湊卡有「更多」與收藏入口', state.more === true && (state.quickCapture === true || state.captureSave === true),
                { more: state.more, moreLabel: state.moreLabel, quickCapture: state.quickCapture, captureSave: state.captureSave });
            check('B14 緊湊卡不顯示進階編輯（文章擷取／建書／待傳）',
                state.articleExtract !== true && state.bookPage !== true && state.capturePendingVisible !== true,
                { articleExtract: state.articleExtract, bookPage: state.bookPage, pending: state.capturePendingVisible });
            const fitted = await waitUntil(async () => {
                const next = await frameState(frame);
                return next && next.contentHeight <= next.innerHeight + 2 && next.contentWidth <= next.innerWidth + 2
                    ? { state: next, box: await panelBox(frame) } : null;
            }, { timeout: 5000 });
            const settled = fitted?.state || (await frameState(frame));
            check('B15 自動高度：內容完整塞進 iframe（沒有裁切、沒有內部捲動）',
                !!fitted,
                { fixedAfterMs: fitted ? '<=5000' : 'never', contentHeight: settled.contentHeight, innerHeight: settled.innerHeight,
                    contentWidth: settled.contentWidth, innerWidth: settled.innerWidth, box: summarizeBox(fitted?.box) });
            note('自動高度收斂後尺寸', summarizeBox(fitted?.box || (await panelBox(frame))));
            check('B16 查詞確實呼叫一次 AI（新詞）', env.state.aiCalls > aiBeforeSelect, { before: aiBeforeSelect, after: env.state.aiCalls });
            check('B17 小窗標記為內嵌模式（ext-inline）', state.inline === true);
            note('基線幾何', { selection: summarizeBox(selection.rect), box: summarizeBox(box), viewport });
            await screenshot(page, 'compact-anchored');
        });

        /* ---------------- C. 視窗四邊 ---------------- */
        await section('C', async () => {
            await closePopup();
            const probesReady = await installEdgeProbes(page);
            check('C0 邊界探針已注入頁面（前提成立）', !!probesReady);
            const cases = [
                { id: 'top', word: 'alphaword', expect: 'below' },
                { id: 'bottom', word: 'omegaword', expect: 'above' },
                { id: 'left', word: 'leftword', expect: 'any' },
                { id: 'right', word: 'rightword', expect: 'any' }
            ];
            for (const [index, entry] of cases.entries()) {
                const opened = await openPopup({ word: entry.word });
                if (!opened.ok) { check(`C${index + 1} 邊界 ${entry.id}：可開啟小窗`, false, opened); continue; }
                const box = await panelBox(opened.frame);
                const rect = opened.info.rect;
                const anchor = box ? anchored(box, rect) : { below: false, above: false, gap: -1 };
                const verticalOk = !!box && (anchor.below || anchor.above) && anchor.gap >= -3 && anchor.gap <= 24;
                const horizontalOk = !!box && horizontalOverlap(box, rect) > 0;
                const viewportOk = !!box && insideViewport(box, viewport);
                const directionOk = entry.expect === 'below' ? anchor.below === true
                    : entry.expect === 'above' ? anchor.above === true : true;
                check(`C${index + 1} 邊界 ${entry.id}：貼著選區、翻轉／夾限正確且完整留在視窗內`,
                    verticalOk && horizontalOk && viewportOk && directionOk,
                    { expect: entry.expect, below: anchor.below, above: anchor.above, gap: round(anchor.gap),
                        box: summarizeBox(box), selection: summarizeBox(rect), viewportOk, horizontalOk });
                if (entry.id === 'bottom') await screenshot(page, 'edge-bottom-flip');
                await closePopup();
            }
        });

        /* ---------------- D. 多行短語 ---------------- */
        await section('D', async () => {
            const opened = await openPopup({ word: 'worry about markets' });
            if (!opened.ok) { check('D0 多行短語：可開啟小窗', false, opened); return; }
            check('D1 多行短語：選區確實跨行（前提成立）',
                opened.info.rects.length >= 2 && opened.info.selected === 'worry about markets',
                { rects: opened.info.rects.length, selected: opened.info.selected });
            await waitForResult(opened.frame);
            const box = await panelBox(opened.frame);
            const anchor = box ? anchored(box, opened.info.rect) : { below: false, above: false, gap: -1 };
            check('D2 多行短語：按整個選區（union）定位且留在視窗內',
                !!box && (anchor.below || anchor.above) && anchor.gap <= 24 && insideViewport(box, viewport)
                && horizontalOverlap(box, opened.info.rect) > 0,
                { below: anchor.below, above: anchor.above, gap: round(anchor.gap), box: summarizeBox(box), selection: summarizeBox(opened.info.rect) });
            const state = await frameState(opened.frame);
            check('D3 多行短語：查的是完整短語且顯示結果',
                state.word === 'worry about markets' && !!state.meaning, { word: state.word, meaning: state.meaning });
            check('D4 多行短語：寬高仍符合小窗',
                !!box && Math.abs(box.width - TARGET_WIDTH) <= 10 && box.height <= 400,
                { width: round(box?.width || 0), height: round(box?.height || 0) });
            await screenshot(page, 'phrase-multiline');
            await closePopup();
        });

        /* ---------------- E. 捲動 ---------------- */
        await section('E', async () => {
            await prepareArticle(page, env, 'scroll=1');
            await installScrollProbes(page);
            await page.evaluate(() => document.getElementById('ds-flow-target').scrollIntoView({ block: 'center' }));
            await sleep(200);
            const opened = await openPopup({ word: 'scrollword' });
            if (!opened.ok) { check('E0 頁面捲動：可先開啟小窗', false, opened); return; }
            const beforeBox = await panelBox(opened.frame);
            const beforeRect = await selectionInfo(page, { word: 'scrollword' });
            await page.evaluate(() => window.scrollBy(0, 80));
            const movedRect = await waitUntil(async () => {
                const rect = await selectionInfo(page, { word: 'scrollword' });
                return rect && beforeRect && Math.abs(rect.rect.y - beforeRect.rect.y) > 40 ? rect.rect : null;
            }, { timeout: 4000 });
            await sleep(500);
            const afterFrame = livePanels(page, base)[0] || null;
            const afterBox = afterFrame ? await panelBox(afterFrame) : null;
            const anchor = afterBox && movedRect ? anchored(afterBox, movedRect) : { below: false, above: false, gap: -1 };
            check('E1 頁面捲動：卡片跟隨選詞（仍貼著被選的文字）',
                !!afterBox && (anchor.below || anchor.above) && anchor.gap <= 24,
                { beforeBox: summarizeBox(beforeBox), afterBox: summarizeBox(afterBox),
                    selectionDelta: round((movedRect?.y || 0) - (beforeRect?.rect.y || 0)),
                    boxDelta: round((afterBox?.y || 0) - (beforeBox?.y || 0)), below: anchor.below, above: anchor.above });
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            check('E2 頁面捲動：選詞離開可視範圍就收起（Q5）', await waitForPanelGone(page, base, 8000),
                { panels: livePanels(page, base).length });
            if (livePanels(page, base).length) await closePopup();

            await page.evaluate(() => window.scrollTo(0, 0));
            await sleep(200);
            await page.evaluate(() => document.getElementById('ds-container').scrollIntoView({ block: 'center' }));
            await sleep(200);
            const inside = await openPopup({ word: 'containerword' });
            if (!inside.ok) { check('E0b 容器捲動：可先開啟小窗', false, inside); return; }
            const innerBefore = await panelBox(inside.frame);
            const innerRectBefore = await selectionInfo(page, { word: 'containerword' });
            await page.evaluate(() => { document.getElementById('ds-container').scrollTop = 18; });
            const innerMoved = await waitUntil(async () => {
                const rect = await selectionInfo(page, { word: 'containerword' });
                return rect && innerRectBefore && Math.abs(rect.rect.y - innerRectBefore.rect.y) > 8 ? rect.rect : null;
            }, { timeout: 4000 });
            await sleep(500);
            const innerFrame = livePanels(page, base)[0] || null;
            const innerAfter = innerFrame ? await panelBox(innerFrame) : null;
            const innerAnchor = innerAfter && innerMoved ? anchored(innerAfter, innerMoved) : { below: false, above: false, gap: -1 };
            check('E3 容器捲動：卡片跟隨（仍在同一個選詞旁）',
                !!innerAfter && (innerAnchor.below || innerAnchor.above) && innerAnchor.gap <= 24,
                { beforeBox: summarizeBox(innerBefore), afterBox: summarizeBox(innerAfter),
                    movedY: round(innerMoved?.y || 0), below: innerAnchor.below, above: innerAnchor.above });
            await page.evaluate(() => { document.getElementById('ds-container').scrollTop = 900; });
            check('E4 容器捲動：選詞被容器捲走就收起', await waitForPanelGone(page, base, 8000),
                { panels: livePanels(page, base).length });
            if (livePanels(page, base).length) await closePopup();
        });

        /* ---------------- F. 關閉路徑 ---------------- */
        await section('F', async () => {
            await prepareArticle(page, env, 'closing=1');
            const opened = await openPopup({ word: 'investors' });
            if (!opened.ok) { check('F0 卡內點擊：可先開啟小窗', false, opened); return; }
            await waitForResult(opened.frame);
            const before = await frameState(opened.frame);
            const aiBeforeInside = env.state.aiCalls;
            await opened.frame.locator('#ext-result-meaning').click({ timeout: 5000 }).catch(() => {});
            await sleep(500);
            const afterInside = livePanels(page, base)[0] || null;
            const insideState = afterInside ? await frameState(afterInside) : {};
            check('F1 卡內點擊不誤關（點在小窗內保持開啟、結果不變）',
                !!afterInside && insideState.word === before.word && insideState.meaning === before.meaning,
                { open: !!afterInside, word: insideState.word });
            check('F2 卡內點擊不重跑 AI', env.state.aiCalls === aiBeforeInside, { aiCalls: env.state.aiCalls - aiBeforeInside });
            await page.keyboard.press('Escape');
            check('F3 卡內 Esc 收起小窗（Q3）', await waitForPanelGone(page, base, 8000), { panels: livePanels(page, base).length });
            if (livePanels(page, base).length) await closePopup();

            const second = await openPopup({ word: 'worry' });
            if (!second.ok) { check('F0b 頁面 Esc：可先開啟小窗', false, second); return; }
            await page.locator('body').press('Escape').catch(() => {});
            check('F4 頁面 Esc 收起小窗（Q3）', await waitForPanelGone(page, base, 8000));
            if (livePanels(page, base).length) await closePopup();

            const third = await openPopup({ word: 'remain' });
            if (!third.ok) { check('F0c 外部點擊：可先開啟小窗', false, third); return; }
            await waitForResult(third.frame);
            await page.mouse.click(4, viewport.height - 6);
            check('F5 外部點擊收起一般小窗（Q3）', await waitForPanelGone(page, base, 8000));
            if (livePanels(page, base).length) await closePopup();

            const fourth = await openPopup({ word: 'People' });
            if (!fourth.ok) { check('F0d 換新詞：可開啟小窗', false, fourth); return; }
            const firstTicket = await panelTicket(fourth.frame);
            await waitForResult(fourth.frame);
            const fifth = await openPopup({ word: 'decisions' });
            const latest = fifth.ok ? await waitUntil(async () => {
                const frame = livePanels(page, base)[0] || null;
                if (!frame) return null;
                const state = await frameState(frame);
                return state.word === 'decisions' ? frame : null;
            }, { timeout: 45000 }) : null;
            const panels = livePanels(page, base);
            const latestState = latest ? await frameState(latest) : {};
            check('F6 換新詞（再點查詞）全頁只保留單一小窗', fifth.ok && panels.length === 1,
                { panels: panels.length, fifth: fifth.ok });
            check('F7 新詞用新票據並顯示新詞', !!latest && (await panelTicket(latest)) !== firstTicket && latestState.word === 'decisions',
                { ticketChanged: !!latest && (await panelTicket(latest)) !== firstTicket, word: latestState.word });
            // 普通選取（不點查詞）：不得換卡、不得新增 AI 請求（外部點擊本來就會收起一般卡，故允許 0 或同一張卡）。
            const aiBeforePlain = env.state.aiCalls;
            const ticketsBeforePlain = livePanels(page, base).map((frame) => frame.url());
            await selectByWord(page, { word: 'gather' });
            await sleep(800);
            const panelsAfterPlain = livePanels(page, base);
            check('F8 普通選取不換卡、不呼叫 AI（Q5）',
                env.state.aiCalls === aiBeforePlain && panelsAfterPlain.length <= 1
                && panelsAfterPlain.every((frame) => ticketsBeforePlain.includes(frame.url())),
                { panels: panelsAfterPlain.length, aiCalls: env.state.aiCalls - aiBeforePlain });
        });

        /* ---------------- G. 更多／返回 ---------------- */
        let expandFrame = null;
        let compactBox = null;
        let compactState = null;
        await section('G', async () => {
            await closePopup();
            await prepareArticle(page, env, 'expand=1');
            const opened = await openPopup({ word: 'volatile' });
            if (!opened.ok) { check('G0 更多：可先開啟小窗', false, opened); return; }
            expandFrame = opened.frame;
            await waitForResult(expandFrame);
            compactState = await frameState(expandFrame);
            compactBox = await panelBox(expandFrame);
            const compactTicket = await panelTicket(expandFrame);
            const mark = requestLog.length;
            const aiBefore = env.state.aiCalls;
            const clicked = await expandFrame.locator('#ext-inline-more').click({ timeout: 5000 }).then(() => true).catch(() => false);
            const expanded = await waitUntil(async () => {
                const state = await frameState(expandFrame);
                return state.expanded === true ? state : null;
            }, { timeout: 8000 });
            const expandedBox = await panelBox(expandFrame);
            check('G1 點「更多」展開完整面板（body.ext-expanded）',
                clicked && !!expanded && expanded.compact !== true, { clicked, classes: expanded?.classes || compactState.classes });
            check('G2 展開後同一個 iframe 變大且仍在視窗內',
                !!expandedBox && !!compactBox && expandedBox.height > compactBox.height + 40 && insideViewport(expandedBox, viewport),
                { compact: summarizeBox(compactBox), expanded: summarizeBox(expandedBox), viewport });
            check('G3 展開保留結果與同一個 iframe／票據（沒有重建）',
                !!expanded && expanded.word === compactState.word && expanded.meaning === compactState.meaning
                && (await panelTicket(expandFrame)) === compactTicket && !expandFrame.isDetached(),
                { word: expanded?.word, sameTicket: (await panelTicket(expandFrame)) === compactTicket });
            check('G4 展開不重跑 AI（沿用既有結果）',
                env.state.aiCalls === aiBefore && aiRequestsSince(mark) === 0,
                { before: aiBefore, after: env.state.aiCalls, aiRequests: aiRequestsSince(mark) });
            check('G5 展開後可見進階操作（建書／文章擷取）',
                !!expanded && expanded.bookPage === true && expanded.articleExtract === true,
                { bookPage: expanded?.bookPage, articleExtract: expanded?.articleExtract });
            note('展開尺寸', { compact: summarizeBox(compactBox), expanded: summarizeBox(expandedBox) });
            await screenshot(page, 'expanded-panel');
            const backClicked = await expandFrame.locator('#ext-inline-back').click({ timeout: 5000 }).then(() => true).catch(() => false);
            const backState = await waitUntil(async () => {
                const state = await frameState(expandFrame);
                return state.compact === true ? state : null;
            }, { timeout: 8000 });
            const backBox = await panelBox(expandFrame);
            check('G6 返回小窗（body.ext-compact）且高度回到緊湊',
                backClicked && !!backState && !!backBox && !!compactBox && backBox.height <= compactBox.height + 24,
                { clicked: backClicked, box: summarizeBox(backBox), compact: summarizeBox(compactBox) });
            check('G7 返回後結果仍在、沒有重跑 AI',
                !!backState && backState.word === compactState.word && env.state.aiCalls === aiBefore,
                { word: backState?.word, aiCalls: env.state.aiCalls - aiBefore });
        });

        /* ---------------- H. 編輯固定與明確關閉 ---------------- */
        await section('H', async () => {
            if (!expandFrame || expandFrame.isDetached()) {
                const again = await openPopup({ word: 'Outlook' });
                if (!again.ok) { check('H0b 編輯情境：可開啟小窗', false, again); return; }
                expandFrame = again.frame;
                await waitForResult(expandFrame);
                compactState = await frameState(expandFrame);
            }
            if (!(await expandPanel(expandFrame))) { check('H0a 可展開面板（前提成立）', false); return; }
            const extractClicked = await expandFrame.locator('#ext-article-extract').click({ timeout: 5000 }).then(() => true).catch(() => false);
            const previewShown = extractClicked ? !!(await waitUntil(async () => {
                const hidden = await expandFrame.evaluate(() => document.getElementById('ext-article-preview')?.hidden !== false).catch(() => true);
                return hidden === false;
            }, { timeout: 60000 })) : false;
            check('H1 展開後可從本頁擷取文章並建立可編輯草稿', previewShown, { extractClicked, previewShown });
            const draft = '選詞旁小窗的未保存草稿（必須保護）';
            const filled = previewShown && await expandFrame.locator('#ext-article-body').fill(draft, { timeout: 5000 }).then(() => true).catch(() => false);
            check('H2 可編輯草稿（前提成立）', filled);
            await page.mouse.click(4, viewport.height - 6);
            await sleep(800);
            const afterOutside = await frameState(expandFrame);
            check('H3 dirty 時外部點擊不自動關閉（Q7）',
                !expandFrame.isDetached() && afterOutside.expanded === true,
                { detached: expandFrame.isDetached(), classes: afterOutside.classes });
            await page.evaluate(() => window.scrollBy(0, 60));
            await sleep(800);
            check('H4 dirty 時捲動也不自動關閉（Q7）', !expandFrame.isDetached(), { detached: expandFrame.isDetached() });
            await page.evaluate(() => window.scrollBy(0, -60));
            await sleep(300);

            const closeClicked = await expandFrame.locator('#ext-inline-close').click({ timeout: 5000 }).then(() => true).catch(() => false);
            const confirmState = await waitUntil(async () => {
                const state = await frameState(expandFrame);
                return state.confirm && state.keep && state.discard ? state : null;
            }, { timeout: 8000 });
            check('H5 明確關閉且有草稿時要確認（#ext-inline-confirm／keep／discard）',
                closeClicked && !!confirmState && !expandFrame.isDetached(),
                { clicked: closeClicked, confirm: confirmState?.confirm, keep: confirmState?.keep, discard: confirmState?.discard });
            await screenshot(page, 'dirty-confirm');
            await expandFrame.locator('#ext-inline-keep').click({ timeout: 5000 }).catch(() => {});
            await sleep(600);
            const kept = await frameState(expandFrame);
            check('H6 選「保留」：面板不關、草稿仍在',
                !expandFrame.isDetached() && kept.articleBody === draft && kept.confirm !== true,
                { detached: expandFrame.isDetached(), draftKept: kept.articleBody === draft, confirmStillVisible: kept.confirm });

            // busy：AI 執行中（慢速 mock）按外部也不得關
            await context.route('**/mock-ai/**', async (route) => { await sleep(2500); await route.continue().catch(() => {}); });
            const busyClicked = await expandFrame.locator('#ext-article-extract').click({ timeout: 5000 }).then(() => true).catch(() => false);
            await sleep(500);
            await page.mouse.click(4, viewport.height - 6);
            await sleep(700);
            check('H7 busy（AI 執行中）外部點擊不自動關閉', busyClicked && !expandFrame.isDetached(),
                { clicked: busyClicked, detached: expandFrame.isDetached() });
            await sleep(3000);
            await context.unroute('**/mock-ai/**').catch(() => {});
            const previewAgain = await waitUntil(async () => {
                const hidden = await expandFrame.evaluate(() => document.getElementById('ext-article-preview')?.hidden !== false).catch(() => true);
                return hidden === false;
            }, { timeout: 30000 });
            const redraft = previewAgain
                ? await expandFrame.locator('#ext-article-body').fill(draft + '（第二版）', { timeout: 5000 }).then(() => true).catch(() => false)
                : false;
            const closeAgain = await expandFrame.locator('#ext-inline-close').click({ timeout: 5000 }).then(() => true).catch(() => false);
            const confirmAgain = await waitUntil(async () => (await frameState(expandFrame)).confirm === true, { timeout: 8000 });
            const discardClicked = confirmAgain ? await expandFrame.locator('#ext-inline-discard').click({ timeout: 5000 }).then(() => true).catch(() => false) : false;
            check('H8 選「放棄」後關閉小窗',
                !!redraft && closeAgain && confirmAgain && discardClicked && await waitForPanelGone(page, base, 10000),
                { redraft, closeAgain, confirmAgain, discardClicked, panels: livePanels(page, base).length });
            if (livePanels(page, base).length) await closePopup();
        });

        /* ---------------- I. 快速收藏與目標沿用 ---------------- */
        await section('I', async () => {
            await prepareArticle(page, env, 'capture=1');
            const pageUrl = page.url();
            const opened = await openPopup({ word: 'plunge' });
            if (!opened.ok) { check('I0 快速收藏：可先開啟小窗', false, opened); return; }
            await waitForResult(opened.frame);
            const shown = await frameState(opened.frame);
            const before = env.state.captureCalls.length;
            const aiBefore = env.state.aiCalls;
            const booksBefore = dbBooks(env).length;
            const action = await captureCurrent(opened.frame);
            const saved = await waitUntil(async () => {
                const state = await frameState(opened.frame);
                return SUCCESS_TEXT.test(state.captureNotice || '') ? state : null;
            }, { timeout: 25000 });
            const calls = env.state.captureCalls.slice(before);
            const request = calls[calls.length - 1] || null;
            const pageBook = dbBookByPage(env, 'alice', pageUrl);
            const entries = pageBook ? dbEntriesFor(env, 'alice', pageBook.id, 'plunge') : [];
            check('I1 沒有可用目標時，一鍵建立本頁詞書並加入當前結果（Q6）',
                action.clicked && !!saved && !!pageBook && calls.length >= 1,
                { selector: action.selector, saved: !!saved, pageBook: pageBook?.id || '', booksBefore, booksAfter: dbBooks(env).length });
            check('I2 收藏寫入的是畫面上的結果（不重跑 AI）',
                !!request && request.word === 'plunge' && !!request.meaning
                && (shown.meaning || '').includes(String(request.meaning).slice(0, 6))
                && env.state.aiCalls === aiBefore,
                { request: request && { word: request.word, bookId: request.bookId, meaning: request.meaning },
                    shownMeaning: shown.meaning, aiCalls: env.state.aiCalls - aiBefore });
            check('I3 收藏帶上來源網址、頁面標題與選區錨點（原意／來源）',
                !!request && request.source?.sourceUrl === pageUrl
                && request.source?.anchor?.quote === 'plunge' && request.source?.pageTitle === PAGE_TITLE,
                { source: request?.source && { sourceUrl: request.source.sourceUrl, pageTitle: request.source.pageTitle, anchor: request.source.anchor } });
            check('I4 收藏記錄目前介面語言', !!request && ['zh-CN', 'zh-HK'].includes(request.source?.locale),
                { locale: request?.source?.locale });
            check('I5 伺服器回執成立：詞書與詞條都真的寫進 DB（不是假成功）',
                !!saved && !!pageBook && entries.length === 1 && !!entries[0].meaning,
                { book: pageBook && { id: pageBook.id, name: pageBook.name, sourceUrl: pageBook.sourceUrl },
                    entries: entries.map((entry) => ({ word: entry.word, meaning: entry.meaning })) });
            const nameShown = !!pageBook?.name && (saved?.bodyText || '').includes(pageBook.name);
            check('I6 小窗顯示目標詞書名稱（Q6：顯示目標名稱）',
                nameShown || (saved?.captureBookName || '') === (pageBook?.name || ''),
                { bookName: pageBook?.name, shownName: saved?.captureBookName, nameShown });
            await screenshot(page, 'quick-capture');
            await closePopup();

            // 明確預設 → 沒有頁書的新頁面要沿用
            await popup.bringToFront();
            await popup.locator('#ext-capture-book').selectOption('book-2');
            await popup.locator('#ext-book-set-default').click();
            const defaultSet = await waitUntil(() => env.db.prepare("SELECT default_book_id FROM vocabulary_capture_settings WHERE owner_user_id='alice'").get()?.default_book_id === 'book-2', { timeout: 10000 });
            check('I7 可在可信頁面明確設定預設詞書（前提成立）', !!defaultSet);

            await page.bringToFront();
            await prepareArticle(page, env, 'capture=1&other=1');
            const defaultCase = await openPopup({ word: 'remain' });
            if (!defaultCase.ok) {
                check('I0b 新頁面沿用明確預設：可開啟小窗', false, defaultCase);
            } else {
                await waitForResult(defaultCase.frame);
                const mark = env.state.captureCalls.length;
                await captureCurrent(defaultCase.frame);
                await waitUntil(() => env.state.captureCalls.length > mark, { timeout: 20000 });
                const call = env.state.captureCalls[env.state.captureCalls.length - 1];
                check('I8 新頁面沒有頁書時沿用「明確預設」詞書（Q6 次序）', call?.bookId === 'book-2',
                    { bookId: call?.bookId, word: call?.word });
                await closePopup();
            }

            // 回到有頁書的頁面 → 頁書優先於預設
            await prepareArticle(page, env, 'capture=1');
            const pageBookCase = await openPopup({ word: 'stocks' });
            if (!pageBookCase.ok) {
                check('I0c 有頁書的頁面：可開啟小窗', false, pageBookCase);
            } else {
                await waitForResult(pageBookCase.frame);
                const mark = env.state.captureCalls.length;
                await captureCurrent(pageBookCase.frame);
                await waitUntil(() => env.state.captureCalls.length > mark, { timeout: 20000 });
                const call = env.state.captureCalls[env.state.captureCalls.length - 1];
                check('I9 有頁書時頁書優先於明確預設（Q6 次序）', call?.bookId === pageBook?.id,
                    { bookId: call?.bookId, pageBookId: pageBook?.id, word: call?.word });

                // 同頁明確選書 → 下一次沿用同頁選擇（優先於頁書）
                const optionsLoaded = await waitUntil(async () => (await frameState(pageBookCase.frame)).captureBookOptions.includes('Reading'), { timeout: 8000 });
                const switched = optionsLoaded && await pageBookCase.frame.locator('#ext-capture-book').selectOption('book-2', { timeout: 5000 }).then(() => true).catch(() => false);
                await sleep(400);
                const mark2 = env.state.captureCalls.length;
                await captureCurrent(pageBookCase.frame);
                await waitUntil(() => env.state.captureCalls.length > mark2, { timeout: 20000 });
                const call2 = env.state.captureCalls[env.state.captureCalls.length - 1];
                check('I10 同頁明確選擇的詞書優先於頁書與預設（Q6 次序）',
                    switched && call2?.bookId === 'book-2' && call2?.requestId !== call?.requestId,
                    { switched, bookId: call2?.bookId, word: call2?.word });
                await closePopup();
            }

            /* ---- I11–I17：0 本詞書帳號的空狀態提示 ----------------------------------
             * 產品本輪只改了 locales 的 extension.captureNoBooks（舊文案叫人先回 BDC 建書）。
             * 這裡用一個真正 0 本詞書的帳號，讀「下拉佔位文字＋提示列＋一鍵建書按鈕」的實際 DOM，
             * 兩語都比對產品字典值，並確認前端沒有硬編碼、提示的承諾（在此新建）真的成立。 */
            const dictionaries = await localeDictionaries();
            const dictText = (locale, key) => String(dictionaries?.[locale]?.extension?.[key] || '');
            const expectedText = {
                'zh-CN': { noBooks: dictText('zh-CN', 'captureNoBooks'), create: dictText('zh-CN', 'inlineCreateAndCapture') },
                'zh-HK': { noBooks: dictText('zh-HK', 'captureNoBooks'), create: dictText('zh-HK', 'inlineCreateAndCapture') }
            };
            note('字典 extension.captureNoBooks', { 'zh-CN': expectedText['zh-CN'].noBooks, 'zh-HK': expectedText['zh-HK'].noBooks });
            const EMPTY_USER = 'carol';
            const EMPTY_TOKEN = 'c'.repeat(43);
            env.db.prepare('INSERT OR IGNORE INTO users(token_hash,user_id,label,role) VALUES(?,?,?,?)')
                .run(createHash('sha256').update(EMPTY_TOKEN).digest('hex'), EMPTY_USER, EMPTY_USER, 'user');
            const emptyBooksBefore = dbBooks(env, EMPTY_USER).filter((book) => !book.deleted).length;
            const switchLocale = async (locale) => {
                await popup.bringToFront();
                await popup.locator('#ext-locale-select').selectOption(locale);
                await sleep(400);
            };
            const logout = async () => {
                await popup.bringToFront();
                if (!(await popup.locator('#ext-logout-btn').isDisabled())) {
                    await popup.locator('#ext-logout-btn').click({ timeout: 10000 }).catch(() => {});
                    await popup.waitForFunction(() => document.getElementById('ext-logout-btn').disabled === true, null, { timeout: 20000 }).catch(() => {});
                }
            };
            // 空詞書時下拉只有一個佔位選項：等它出現就代表書單已載入，不必等提示列（查詞會把它清掉）。
            const openEmptyBookPopup = async (tag) => {
                await page.bringToFront();
                await prepareArticle(page, env, 'empty-book=' + tag);
                const opened = await openPopup({ word: 'plunge' });
                if (!opened.ok) return { ok: false, opened };
                await waitForResult(opened.frame);
                const settled = await waitUntil(async () => {
                    const next = await frameState(opened.frame);
                    return next && next.captureBookPlaceholder ? next : null;
                }, { timeout: 15000 });
                return { ok: true, frame: opened.frame, state: settled || await frameState(opened.frame) };
            };
            // 收藏區自己的可見文字（不含外殼工具列的「BDC 網頁查詞」品牌字樣），用來掃 BDC／舊引導。
            const captureSurfaces = (state) => [state?.captureNotice, state?.captureBookPlaceholder,
                state?.captureHint, state?.quickCaptureLabel, state?.captureSectionText].filter(Boolean).join(' ');
            // 展開後按一次「刷新」讓書單重新載入：這是提示列（#ext-capture-notice）真正渲染 captureNoBooks 的路徑。
            const expandAndRefresh = async (frame, expectedNotice) => {
                const expanded = await expandPanel(frame);
                const clicked = expanded && await frame.locator('#ext-capture-refresh').click({ timeout: 8000 }).then(() => true).catch(() => false);
                const matched = clicked ? await waitUntil(async () => {
                    const next = await frameState(frame);
                    return next.captureNotice === expectedNotice ? next : null;
                }, { timeout: 15000 }) : null;
                return { expanded, clicked, matched, state: matched || await frameState(frame) };
            };
            try {
                await logout();
                await connect(EMPTY_TOKEN, EMPTY_USER);
                await switchLocale('zh-CN');
                const cn = await openEmptyBookPopup('cn');
                if (!cn.ok || emptyBooksBefore !== 0) {
                    check('I11 空詞書帳號可開啟小窗且確實 0 本詞書（前提成立）', false,
                        { opened: cn.ok, books: emptyBooksBefore, reason: cn.opened?.reason });
                    return;
                }
                const cnCompact = cn.state;
                await panelShot(cn.frame, 'empty-book-zh-CN-compact-panel');
                await screenshot(page, 'empty-book-zh-CN-compact');
                check('I11 zh-CN 空詞書：下拉佔位文字與「建立本頁詞書並加入」按鈕都引導在此新建，卡片沒有 BDC／「先在…」舊引導',
                    cnCompact.captureBookPlaceholder === expectedText['zh-CN'].noBooks
                    && cnCompact.quickCapture === true
                    && cnCompact.quickCaptureLabel === expectedText['zh-CN'].create
                    && cnCompact.needsBook === true
                    && !/BDC/i.test(captureSurfaces(cnCompact))
                    && !/先在|請先|请先/.test(captureSurfaces(cnCompact)),
                    { placeholder: cnCompact.captureBookPlaceholder, quickCapture: cnCompact.quickCapture,
                        quickCaptureLabel: cnCompact.quickCaptureLabel, needsBook: cnCompact.needsBook,
                        notice: cnCompact.captureNotice, surfaces: captureSurfaces(cnCompact) });

                const cnNotice = await expandAndRefresh(cn.frame, expectedText['zh-CN'].noBooks);
                await panelShot(cn.frame, 'empty-book-zh-CN-expanded-panel');
                await screenshot(page, 'empty-book-zh-CN-expanded');
                check('I12 zh-CN 空詞書提示列顯示同一條新文字（不再叫人先回 BDC），展開面板提示行也說「直接新建」',
                    cnNotice.expanded && cnNotice.clicked
                    && cnNotice.state.captureNotice === expectedText['zh-CN'].noBooks
                    && cnNotice.state.captureNoticeHidden === false
                    && cnNotice.state.captureHint === dictText('zh-CN', 'captureChooseToSave')
                    && !/BDC/i.test(cnNotice.state.captureNotice + cnNotice.state.captureHint),
                    { expanded: cnNotice.expanded, clicked: cnNotice.clicked, notice: cnNotice.state.captureNotice,
                        noticeHidden: cnNotice.state.captureNoticeHidden, hint: cnNotice.state.captureHint,
                        expectedHint: dictText('zh-CN', 'captureChooseToSave') });

                // 觀察（不判定成敗）：緊湊卡剛開好時提示列是空的（本次實測 notice:""），按「刷新」後才有文字。
                note('空詞書提示列的可見時機（觀察，不判定成敗）',
                    { compact: cnCompact.captureNotice, afterRefresh: cnNotice.state.captureNotice });
                await closePopup();

                // zh-HK：用 locale 欄位切換（不另造 HK 空帳號），重開小窗後讀同一批 DOM。
                await switchLocale('zh-HK');
                const hk = await openEmptyBookPopup('hk');
                if (!hk.ok) { check('I13 zh-HK 空詞書：可開啟小窗（前提成立）', false, hk.opened); return; }
                const hkCompact = hk.state;
                await panelShot(hk.frame, 'empty-book-zh-HK-compact-panel');
                await screenshot(page, 'empty-book-zh-HK-compact');
                check('I13 zh-HK 空詞書：下拉佔位與按鈕改用香港繁體同一條文字，不是 zh-CN 文字，也沒有 BDC／「先…」',
                    hkCompact.captureBookPlaceholder === expectedText['zh-HK'].noBooks
                    && hkCompact.quickCaptureLabel === expectedText['zh-HK'].create
                    && hkCompact.needsBook === true
                    && hkCompact.captureBookPlaceholder !== expectedText['zh-CN'].noBooks
                    && !captureSurfaces(hkCompact).includes(expectedText['zh-CN'].noBooks)
                    && !/BDC/i.test(captureSurfaces(hkCompact))
                    && !/先在|請先|请先/.test(captureSurfaces(hkCompact)),
                    { placeholder: hkCompact.captureBookPlaceholder, quickCaptureLabel: hkCompact.quickCaptureLabel,
                        notice: hkCompact.captureNotice, cnText: expectedText['zh-CN'].noBooks,
                        surfaces: captureSurfaces(hkCompact) });

                const hkNotice = await expandAndRefresh(hk.frame, expectedText['zh-HK'].noBooks);
                await panelShot(hk.frame, 'empty-book-zh-HK-expanded-panel');
                await screenshot(page, 'empty-book-zh-HK-expanded');
                check('I14 zh-HK 空詞書提示列與展開面板提示行都改用香港繁體同一條文字',
                    hkNotice.expanded && hkNotice.clicked
                    && hkNotice.state.captureNotice === expectedText['zh-HK'].noBooks
                    && hkNotice.state.captureNoticeHidden === false
                    && hkNotice.state.captureHint === dictText('zh-HK', 'captureChooseToSave')
                    && hkNotice.state.captureNotice !== expectedText['zh-CN'].noBooks,
                    { expanded: hkNotice.expanded, clicked: hkNotice.clicked, notice: hkNotice.state.captureNotice,
                        noticeHidden: hkNotice.state.captureNoticeHidden, hint: hkNotice.state.captureHint,
                        expectedHint: dictText('zh-HK', 'captureChooseToSave') });
                await closePopup();

                check('I15 兩語字典同鍵同語義：都引導在原地新建、都不含 BDC／「先…」、且無插值參數',
                    !!expectedText['zh-CN'].noBooks && !!expectedText['zh-HK'].noBooks
                    && /新建/.test(expectedText['zh-CN'].noBooks) && /新增/.test(expectedText['zh-HK'].noBooks)
                    && !/BDC/i.test(expectedText['zh-CN'].noBooks + expectedText['zh-HK'].noBooks)
                    && !/先在|請先|请先/.test(expectedText['zh-CN'].noBooks + expectedText['zh-HK'].noBooks)
                    && !/\{\w+\}/.test(expectedText['zh-CN'].noBooks + expectedText['zh-HK'].noBooks)
                    && /新建|新增/.test(dictText('zh-CN', 'captureChooseToSave') + dictText('zh-HK', 'captureChooseToSave')),
                    { cn: expectedText['zh-CN'].noBooks, hk: expectedText['zh-HK'].noBooks,
                        cnChooseToSave: dictText('zh-CN', 'captureChooseToSave'),
                        hkChooseToSave: dictText('zh-HK', 'captureChooseToSave') });

                const hardcoded = frontEndHardcodedEmptyBook();
                const packagedSameAsRoot = {
                    'zh-CN': fileHash('extension/locales/zh-CN.js') === fileHash('locales/zh-CN.js'),
                    'zh-HK': fileHash('extension/locales/zh-HK.js') === fileHash('locales/zh-HK.js')
                };
                const keyRefs = (fs.readFileSync(path.join(ROOT, 'extension/capture-ui.js'), 'utf8').match(/extension\.captureNoBooks/g) || []).length;
                check('I16 前端無硬編碼：extension/ 不含這兩條文字，capture-ui 以 t(\'extension.captureNoBooks\') 取鍵，打包字典與根字典同檔',
                    hardcoded.length === 0 && keyRefs >= 2
                    && packagedSameAsRoot['zh-CN'] && packagedSameAsRoot['zh-HK'],
                    { hardcoded, keyRefs, packagedSameAsRoot });

                // I17：把新提示的承諾兌現——0 本詞書時按「建立本頁詞書並加入」要真的建立並寫入。
                const captureCase = await openEmptyBookPopup('quick');
                if (!captureCase.ok) { check('I17 0 本詞書：可開啟小窗（前提成立）', false, captureCase.opened); return; }
                const callsBefore = env.state.captureCalls.length;
                const quickClicked = await captureCase.frame.locator('#ext-quick-capture').click({ timeout: 8000 }).then(() => true).catch(() => false);
                const savedState = await waitUntil(async () => {
                    const next = await frameState(captureCase.frame);
                    return SUCCESS_TEXT.test(next.captureNotice || '') ? next : null;
                }, { timeout: 30000 });
                const emptyBooksAfter = dbBooks(env, EMPTY_USER).filter((book) => !book.deleted);
                const emptyEntries = emptyBooksAfter.flatMap((book) => dbEntriesFor(env, EMPTY_USER, book.id, 'plunge'));
                const quickCall = env.state.captureCalls.slice(callsBefore).slice(-1)[0] || null;
                await screenshot(page, 'empty-book-quick-capture');
                check('I17 0 本詞書時「建立本頁詞書並加入」真的可用（伺服器回執＋DB 有詞書與詞條）',
                    quickClicked && !!savedState && emptyBooksAfter.length === 1 && emptyEntries.length === 1 && !!quickCall?.source?.sourceUrl,
                    { clicked: quickClicked, notice: savedState?.captureNotice, books: emptyBooksAfter.length,
                        entries: emptyEntries.map((entry) => entry.word),
                        call: quickCall && { bookId: quickCall.bookId, word: quickCall.word, locale: quickCall.source?.locale } });
                await closePopup();
            } catch (error) {
                check('I11–I17 空詞書提示區段執行失敗', false, String((error && error.stack) || error).slice(0, 1500));
            } finally {
                // 不論成敗都要回到 alice＋zh-CN：後面 J–O 的 fixture 全部以 alice 為前提。
                await closePopup().catch(() => {});
                await switchLocale('zh-CN').catch(() => {});
                await logout().catch(() => {});
                const status = await popup.locator('#ext-account-status').textContent().catch(() => '');
                if (!String(status || '').includes('alice')) {
                    await connect(ALICE, 'alice').catch((error) => console.error('[restore alice]', error));
                }
            }
        });

        /* ---------------- J. 失敗不假成功／重試不多建 ---------------- */
        await section('J', async () => {
            await prepareArticle(page, env, 'failure=1');
            const opened = await openPopup({ word: 'investors' });
            if (!opened.ok) { check('J0 失敗情境：可先開啟小窗', false, opened); return; }
            await waitForResult(opened.frame);
            env.state.failCaptures = true;
            const before = env.state.captureCalls.length;
            const aiBefore = env.state.aiCalls;
            await captureCurrent(opened.frame);
            const settled = await waitUntil(async () => {
                const state = await frameState(opened.frame);
                return (state.captureNoticeError || state.capturePendingVisible || PENDING_TEXT.test(state.captureNotice + state.bodyText)) ? state : null;
            }, { timeout: 25000 });
            const failedCall = env.state.captureCalls.slice(before).slice(-1)[0] || null;
            const failedBookId = failedCall?.bookId || '';
            const entriesAfterFail = failedBookId ? dbEntriesFor(env, 'alice', failedBookId, 'investors') : [];
            check('J1 收藏失敗顯示錯誤／待傳，不得顯示成功',
                !!settled && !SUCCESS_TEXT.test(settled.captureNotice || ''),
                { notice: settled?.captureNotice, error: settled?.captureNoticeError, pending: settled?.capturePendingVisible });
            check('J2 收藏失敗沒有在雲端留下詞條（不假成功）', entriesAfterFail.length === 0,
                { bookId: failedBookId, entries: entriesAfterFail.length });
            env.state.failCaptures = false;
            await expandPanel(opened.frame);
            await openPendingBox(opened.frame);
            const mark = requestLog.length;
            const retried = await opened.frame.locator('#ext-capture-pending-list li button').first().click({ timeout: 5000 }).then(() => true).catch(() => false);
            const retriedState = await waitUntil(async () => {
                const state = await frameState(opened.frame);
                return SUCCESS_TEXT.test(state.captureNotice || '') ? state : null;
            }, { timeout: 25000 });
            const retryCall = env.state.captureCalls.slice(before).slice(-1)[0] || null;
            const nowEntries = failedBookId ? dbEntriesFor(env, 'alice', failedBookId, 'investors') : [];
            check('J3 由待傳列重試後成功', retried && !!retriedState, { retried, notice: retriedState?.captureNotice });
            check('J4 重試沿用同一個 requestId（重試不多建）',
                !!failedCall && !!retryCall && failedCall.requestId === retryCall.requestId,
                { failed: failedCall?.requestId, retried: retryCall?.requestId });
            check('J5 重試後詞條只有一筆（沒有重複建立）', nowEntries.length === 1,
                { count: nowEntries.length, words: nowEntries.map((entry) => entry.word) });
            check('J6 重試沒有重跑 AI', env.state.aiCalls === aiBefore && aiRequestsSince(mark) === 0,
                { aiCalls: env.state.aiCalls - aiBefore, aiRequests: aiRequestsSince(mark) });
            await closePopup();

            // 伺服器已套用但回應遺失
            await prepareArticle(page, env, 'lostreply=1');
            const lost = await openPopup({ word: 'worry' });
            if (!lost.ok) { check('J0b 回應遺失情境：可先開啟小窗', false, lost); return; }
            await waitForResult(lost.frame);
            const lostBefore = env.state.captureCalls.length;
            env.state.loseNextReply = true;
            await captureCurrent(lost.frame);
            const lostState = await waitUntil(async () => {
                const state = await frameState(lost.frame);
                return (state.captureNoticeError || state.capturePendingVisible || PENDING_TEXT.test(state.captureNotice + state.bodyText)) ? state : null;
            }, { timeout: 25000 });
            const lostCall = env.state.captureCalls.slice(lostBefore).slice(-1)[0] || null;
            const lostBookId = lostCall?.bookId || '';
            const applied = lostBookId ? dbEntriesFor(env, 'alice', lostBookId, 'worry') : [];
            check('J7 回應遺失時不得宣稱成功，並留下待傳',
                !!lostState && !SUCCESS_TEXT.test(lostState.captureNotice || ''),
                { notice: lostState?.captureNotice, pending: lostState?.capturePendingVisible });
            check('J8 伺服器其實已寫入（回應遺失情境成立）', applied.length === 1,
                { count: applied.length, bookId: lostBookId });
            await expandPanel(lost.frame);
            await openPendingBox(lost.frame);
            await lost.frame.locator('#ext-capture-pending-list li button').first().click({ timeout: 5000 }).catch(() => {});
            const replayed = await waitUntil(async () => {
                const state = await frameState(lost.frame);
                return SUCCESS_TEXT.test(state.captureNotice || '') ? state : null;
            }, { timeout: 25000 });
            const finalEntries = lostBookId ? dbEntriesFor(env, 'alice', lostBookId, 'worry') : [];
            const replayCall = env.state.captureCalls.slice(lostBefore).slice(-1)[0] || null;
            const captureRows = lostCall ? dbCaptureRows(env, 'alice').filter((row) => row.request_id === lostCall.requestId) : [];
            check('J9 重試沿用同一 requestId 並拿到原回執（不多建）',
                !!replayed && finalEntries.length === 1 && !!lostCall && replayCall?.requestId === lostCall.requestId && captureRows.length === 1,
                { replayed: !!replayed, count: finalEntries.length, sameRequest: replayCall?.requestId === lostCall?.requestId, rows: captureRows.length });
            await closePopup();
        });

        /* ---------------- K/L. 偽造訊息與洩漏 ---------------- */
        await section('K', async () => {
            await prepareArticle(page, env, 'forged=1');
            const opened = await openPopup({ word: 'Markets' });
            if (!opened.ok) { check('K0 偽造訊息：可先開啟小窗', false, opened); return; }
            await waitForResult(opened.frame);
            const realTicket = await panelTicket(opened.frame);
            const boxBefore = await panelBox(opened.frame);
            const stateBefore = await frameState(opened.frame);
            const aiBefore = env.state.aiCalls;
            const capturesBefore = env.state.captureCalls.length;
            const entriesBefore = dbEntries(env).length;
            const writesBefore = requestLog.filter((entry) => entry.method !== 'GET').length;
            const framesBefore = livePanels(page, base).length;
            // 先記錄「產品自己的」window message（尚未偽造），再偽造；否則會把自己的偽造訊息誤判成洩漏。
            const leakPosted = await page.evaluate(() => (window.__bdcPosted || []).slice());
            const leakInbound = await page.evaluate(() => (window.__bdcInbound || []).slice());
            await page.evaluate((ticket) => {
                const forged = [
                    { type: 'BDC_INLINE_STATE', ticket, mode: 'expanded', height: 5000, protected: false },
                    { type: 'BDC_INLINE_STATE', ticket, mode: 'compact', height: 40 },
                    { type: 'BDC_INLINE_REMOVE', ticket, requestId: 'forged-1' },
                    { type: 'BDC_INLINE_KEEP', ticket, requestId: 'forged-2' },
                    { type: 'BDC_CLOSE_INLINE', ticket },
                    { type: 'BDC_INLINE_CHECK_CLOSE', ticket, requestId: 'forged-3', reason: 'outside' },
                    { type: 'BDC_INLINE_RESIZE', ticket, height: 900 },
                    { type: 'BDC_INLINE_EXPAND', ticket },
                    { type: 'BDC_QUICK_CAPTURE', ticket },
                    { type: 'BDC_CAPTURE_SAVE', ticket },
                    { type: 'BDC_OPEN_INLINE' },
                    { type: 'BDC_READ_PAGE' }
                ];
                for (const message of forged) window.postMessage(message, '*');
                for (let index = 0; index < window.length; index += 1) {
                    for (const message of forged) {
                        try { window.frames[index].postMessage(message, '*'); } catch (_) { /* cross-origin 保護 */ }
                    }
                }
                for (const type of ['mouseup', 'mousedown', 'click', 'pointerdown']) {
                    document.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true, clientX: 20, clientY: 20 }));
                    document.querySelector('bdc-page-lookup')?.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true }));
                }
            }, realTicket);
            await sleep(1800);
            const boxAfter = await panelBox(opened.frame);
            const stateAfter = await frameState(opened.frame);
            const panels = livePanels(page, base);
            const stillOpen = !opened.frame.isDetached() && panels.length === 1;
            check('K1 網頁偽造訊息（含真 ticket）不能 expand／resize 小窗',
                stillOpen && !!boxAfter && !!boxBefore
                && Math.abs(boxAfter.height - boxBefore.height) <= 2 && Math.abs(boxAfter.width - boxBefore.width) <= 2
                && stateAfter.expanded !== true,
                { before: summarizeBox(boxBefore), after: summarizeBox(boxAfter), classes: stateAfter.classes });
            check('K2 網頁偽造訊息不能關閉小窗', stillOpen && stateAfter.word === stateBefore.word,
                { open: stillOpen, word: stateAfter.word });
            check('K3 網頁偽造訊息不能開新卡或替換內容',
                panels.length === framesBefore && panels.length === 1 && (await panelTicket(panels[0])) === realTicket,
                { panels: panels.length });
            check('K4 網頁偽造訊息不能觸發收藏／AI／寫入',
                env.state.captureCalls.length === capturesBefore && dbEntries(env).length === entriesBefore
                && requestLog.filter((entry) => entry.method !== 'GET').length === writesBefore
                && env.state.aiCalls === aiBefore,
                { captures: env.state.captureCalls.length - capturesBefore, entries: dbEntries(env).length - entriesBefore,
                    writes: requestLog.filter((entry) => entry.method !== 'GET').length - writesBefore, aiCalls: env.state.aiCalls - aiBefore });
            check('K5 合成滑鼠事件不會開卡或改變卡片', panels.length === 1);
            check('K6 網頁讀不到小窗內容（closed shadow root）',
                await page.evaluate(() => document.querySelector('bdc-page-lookup')?.shadowRoot === null));

            const inboundAfter = await page.evaluate(() => window.__bdcInbound || []);
            const serializedPosted = JSON.stringify(leakPosted);
            const serializedInbound = JSON.stringify(leakInbound);
            const secrets = [ALICE, realTicket].filter(Boolean);
            check('L1 網頁世界送出的 window message 不含 ticket／token（產品自己不經網頁通道）',
                secrets.every((secret) => !serializedPosted.includes(secret)) && !/ticket%3D|ticket=/.test(serializedPosted),
                { count: leakPosted.length, sample: leakPosted.slice(0, 3) });
            check('L2 網頁世界收到的 window message 不含 ticket／token（卡片不靠 window message 傳票據）',
                secrets.every((secret) => !serializedInbound.includes(secret)) && !/ticket%3D|ticket=/.test(serializedInbound),
                { count: leakInbound.length, sample: leakInbound.slice(0, 3) });
            check('L5 卡片從未向網頁世界 postMessage（偽造前後都沒有來自 chrome-extension 的訊息）',
                !inboundAfter.some((entry) => String(entry.origin || '').startsWith('chrome-extension://'))
                && !leakInbound.some((entry) => String(entry.origin || '').startsWith('chrome-extension://')),
                { inbound: inboundAfter.length, origins: [...new Set(inboundAfter.map((entry) => entry.origin))] });
            const storageLeak = await page.evaluate(() => ({
                local: JSON.stringify({ ...localStorage }), session: JSON.stringify({ ...sessionStorage }),
                runtimeId: !!(window.chrome && window.chrome.runtime && window.chrome.runtime.id)
            }));
            check('L3 網頁 storage 沒有 ticket／token，網頁世界也沒有 chrome.runtime',
                !storageLeak.local.includes(ALICE) && !storageLeak.session.includes(ALICE)
                && !storageLeak.session.includes('ticket') && storageLeak.runtimeId === false, storageLeak);
            check('L4 網頁無法列出小窗網址（拿不到 ticket）', await page.evaluate(() => {
                try { return !String(window.frames[0]?.location?.href || '').includes('/lookup.html'); } catch (_) { return true; }
            }));
            note('頁面世界訊息', { productPosted: leakPosted.length, productInbound: leakInbound.length, afterForge: inboundAfter.length });
            await closePopup();
        });

        /* ---------------- M. 遲到回應 ---------------- */
        await section('M', async () => {
            await prepareArticle(page, env, 'race=1');
            await context.route('**/mock-ai/**', async (route) => { await sleep(2500); await route.continue().catch(() => {}); });
            const firstOpen = await openPopup({ word: 'decisions' });
            const firstTicket = firstOpen.ok ? await panelTicket(firstOpen.frame) : '';
            const secondOpen = firstOpen.ok ? await openPopup({ word: 'information' }) : { ok: false };
            const latest = secondOpen.ok ? await waitUntil(async () => {
                const frame = livePanels(page, base)[0] || null;
                if (!frame) return null;
                const state = await frameState(frame);
                return state.word === 'information' ? frame : null;
            }, { timeout: 60000 }) : null;
            const panels = livePanels(page, base);
            const state = latest ? await frameState(latest) : {};
            check('M1 連點兩個詞的查詞：全頁仍只有一個小窗',
                firstOpen.ok && secondOpen.ok && panels.length === 1, { panels: panels.length, first: firstOpen.ok, second: secondOpen.ok });
            check('M2 最終顯示的是後點的詞', !!latest && state.word === 'information', { word: state.word });
            check('M3 前一個詞遲到的回應沒有蓋掉新結果（票據已換）',
                !!latest && (await panelTicket(latest)) !== firstTicket,
                { firstTicket: String(firstTicket).slice(0, 8), nowTicket: String(await panelTicket(latest)).slice(0, 8) });
            await context.unroute('**/mock-ai/**').catch(() => {});
            await closePopup();
        });

        /* ---------------- N. 兩語與窄視窗 ---------------- */
        await section('N', async () => {
            await page.setViewportSize({ width: 720, height: 560 });
            const narrow = page.viewportSize();
            const localeResult = {};
            for (const [index, locale] of ['zh-HK', 'zh-CN'].entries()) {
                await popup.bringToFront();
                await popup.locator('#ext-locale-select').selectOption(locale);
                await sleep(400);
                await page.bringToFront();
                await prepareArticle(page, env, 'locale=' + locale);
                const opened = await openPopup({ word: 'plunge' });
                if (!opened.ok) { check(`N${index + 1} ${locale}：窄視窗可開啟小窗`, false, opened); continue; }
                await waitForResult(opened.frame);
                const state = await frameState(opened.frame);
                const box = await panelBox(opened.frame);
                const expected = locale === 'zh-HK' ? /急跌/ : /暴跌/;
                localeResult[locale] = {
                    box: summarizeBox(box), meaning: state.meaning, moreLabel: state.moreLabel,
                    captureLabel: state.quickCaptureLabel || state.captureSaveLabel
                };
                check(`N${index + 1}a ${locale}：詞義使用該語言`, expected.test(state.meaning || ''), { meaning: state.meaning });
                check(`N${index + 1}b ${locale}：窄視窗寬度仍約 340 且完整留在視窗內`,
                    !!box && Math.abs(box.width - TARGET_WIDTH) <= 12 && insideViewport(box, narrow),
                    { box: summarizeBox(box), viewport: narrow });
                check(`N${index + 1}c ${locale}：小窗沒有橫向溢出`,
                    state.contentWidth <= state.innerWidth + 2, { contentWidth: state.contentWidth, innerWidth: state.innerWidth });
                await screenshot(page, 'narrow-' + locale);
                await opened.frame.locator('#ext-inline-more').click({ timeout: 5000 }).catch(() => {});
                const expanded = await waitUntil(async () => {
                    const next = await frameState(opened.frame);
                    return next.expanded ? next : null;
                }, { timeout: 8000 });
                const expandedBox = await panelBox(opened.frame);
                check(`N${index + 1}d ${locale}：展開後不溢出且高度夾限在視窗內`,
                    !!expanded && expanded.contentWidth <= expanded.innerWidth + 2 && !!expandedBox
                    && expandedBox.height <= narrow.height - 8 && insideViewport(expandedBox, narrow),
                    { box: summarizeBox(expandedBox), contentWidth: expanded?.contentWidth, innerWidth: expanded?.innerWidth, viewport: narrow });
                await screenshot(page, 'narrow-expanded-' + locale);
                await closePopup();
            }
            note('locale 幾何', localeResult);
            await page.setViewportSize({ width: 1280, height: 900 });
            viewport = page.viewportSize();
        });

        /* ---------------- O. 帳戶隔離 ---------------- */
        await section('O', async () => {
            const aliceEntriesBefore = dbEntries(env, 'alice').length;
            const aliceBooksBefore = dbBooks(env, 'alice').length;
            await popup.bringToFront();
            await popup.locator('#ext-logout-btn').click();
            await popup.waitForFunction(() => /未登录账户/.test(document.querySelector('#ext-account-status').textContent), null, { timeout: 20000 });
            await connect(BOB, 'bob');
            await page.bringToFront();
            await prepareArticle(page, env, 'isolation=1');
            const opened = await openPopup({ word: 'gather' });
            if (!opened.ok) { check('O0 切換帳戶後仍可開啟小窗', false, opened); return; }
            await waitForResult(opened.frame);
            const state = await frameState(opened.frame);
            check('O1 新帳戶的小窗不沿用上一個帳戶的詞書',
                !state.captureBookOptions.includes('单词本') && !state.captureBookOptions.includes('Reading'),
                { options: state.captureBookOptions });
            const before = env.state.captureCalls.length;
            await captureCurrent(opened.frame);
            await sleep(3000);
            const call = env.state.captureCalls.slice(before).slice(-1)[0] || null;
            const after = await frameState(opened.frame);
            const bobEntries = dbEntries(env, 'bob');
            check('O2 切換帳戶後的收藏不會寫進上一個帳戶',
                dbEntries(env, 'alice').length === aliceEntriesBefore && dbBooks(env, 'alice').length === aliceBooksBefore,
                { aliceEntries: dbEntries(env, 'alice').length, aliceBooks: dbBooks(env, 'alice').length });
            check('O3 若宣稱成功就必須真的寫進目前帳戶（否則不得假成功）',
                SUCCESS_TEXT.test(after.captureNotice || '')
                    ? bobEntries.some((entry) => String(entry.word).toLowerCase() === 'gather') : true,
                { notice: after.captureNotice, bobWords: bobEntries.map((entry) => entry.word), bookId: call?.bookId });
            check('O4 小窗顯示的帳戶與目前登入者一致（不是上一個帳戶）',
                state.accountStatus.includes('bob') && !state.accountStatus.includes('alice'),
                { accountStatus: state.accountStatus });
            await screenshot(page, 'account-isolation');
            await closePopup();
        });

        check('P1 正常流程沒有未捕獲的頁面錯誤', errors.length === 0, errors.slice(0, 5));
        debug.push({ errors, consoles: consoles.slice(0, 20), badResponses: badResponses.slice(0, 20), tail: requestLog.slice(-30) });
    } catch (error) {
        checks.push({ name: 'execution', ok: false, detail: String((error && error.stack) || error).slice(0, 4000) });
        console.error((error && error.stack) || error);
    } finally {
        const passed = checks.filter((item) => item.ok).length;
        const failed = checks.filter((item) => !item.ok).length;
        fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({
            mode: 'full', checks, notes, errors, consoles, badResponses, debug, hashes, screenshots: shots,
            realMV3: true, realWorkerSQLite: true, aiMocked: true, stamp,
            summary: { total: checks.length, passed, failed }
        }, null, 2));
        if (context) await context.close().catch(() => {});
        if (env) await env.close().catch(() => {});
        fs.rmSync(profile, { recursive: true, force: true });
        if (failed) process.exitCode = 1;
        console.log(JSON.stringify({ mode: 'full', passed, failed, total: checks.length, output: OUT }));
    }
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */
(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const readiness = staticReadiness();
    const full = process.argv.includes('--full') || (readyMarkerPresent() && readiness.missing.length === 0);
    if (!full) {
        const summary = await preflight(readiness);
        console.log(JSON.stringify({ exit: 0, reason: summary.verdict }));
        return;
    }
    await acceptance();
})();
