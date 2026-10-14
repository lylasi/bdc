/**
 * DeepSeek 方案 — 懸浮播放器「全頁面常駐」與圖標配色一致性回歸
 *
 * 用途：回答兩個具體問題
 *  1. 聽寫進行中時，#floating-dictation-controls 是否真的在每個模組頁面都可見、可點、不被遮擋？
 *  2. 各頁面的圖標按鈕顏色是否都落在設計令牌（--primary / --ink-* / --line-* / 語義色）內？
 *
 * 執行：
 *   PLAYWRIGHT_MODULE=<playwright 路徑> node tests/floating-player-and-icons.cjs
 *   （本機可用：/Users/linus/.local/share/fnm/node-versions/v24.20.0/installation/lib/node_modules/@playwright/cli/node_modules/playwright）
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8313;
const BASE = `http://127.0.0.1:${PORT}/`;
const ASSETS = path.resolve(__dirname, '..', 'docs', 'report', 'assets-ui-redesign');
fs.mkdirSync(ASSETS, { recursive: true });

const VIEWPORTS = [
    [390, 844],
    [768, 1024],
    [1024, 768],
    [1440, 900]
];

const PAGES = [
    ['v', '单词本'],
    ['l', '学习模式'],
    ['d', '听写模式'],
    ['q', '随堂测验'],
    ['a', '文章详解'],
    ['qa', '问答训练'],
    ['ocr', '图片识别']
];

const books = [{
    id: 'audit-book',
    name: '五年级 · Daily words',
    words: [
        { id: 'audit-apple', word: 'apple', meaning: '苹果', phonetic: 'ˈæpl' },
        { id: 'audit-book-word', word: 'notebook', meaning: '笔记本', phonetic: 'ˈnəʊtbʊk' },
        { id: 'audit-pencil', word: 'pencil', meaning: '铅笔', phonetic: 'ˈpensl' }
    ]
}];

const results = { checks: [], failures: [], report: {} };

function check(name, ok, detail) {
    results.checks.push({ name, ok: !!ok, detail });
    if (!ok) results.failures.push({ name, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`);
}

/** 進入聽寫頁並等「開始聽寫」真的出現。
    應用初始化偶爾比 goto 的 load 事件慢，直接 click 會等到逾時；
    這裡改成「點了沒出來就再點一次」的寬鬆等待，避免整套測試被單次載入慢拖垮。 */
async function openDictation(page) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        await page.locator('#dictation-btn').click({ timeout: 5000 }).catch(() => {});
        try {
            await page.waitForSelector('#start-dictation-btn', { state: 'visible', timeout: 3000 });
            return;
        } catch (_) { /* 再試一次 */ }
    }
    await page.waitForSelector('#start-dictation-btn', { state: 'visible', timeout: 10000 });
}

async function newContext(browser, { width, height, locale = 'zh-CN' }) {
    const context = await browser.newContext({ viewport: { width, height } });
    await context.addInitScript(({ books, locale }) => {
        // 只在不存在時寫入：addInitScript 對每個 frame 都會執行，同源的 about:blank iframe
        // 會共用 localStorage，無條件覆寫會把測試中剛儲存的設定沖掉。
        if (!localStorage.getItem('vocabularyBooks')) localStorage.setItem('vocabularyBooks', JSON.stringify(books));
        if (!localStorage.getItem('activeBookId')) localStorage.setItem('activeBookId', 'audit-book');
        if (!localStorage.getItem('vocabImportPromptShown')) localStorage.setItem('vocabImportPromptShown', '1');
        if (!localStorage.getItem('pen_global_settings')) {
            localStorage.setItem('pen_global_settings', JSON.stringify({ language: { interfaceLocale: locale }, assistant: { enabled: true } }));
        }
        const synth = window.speechSynthesis;
        let timer;
        synth.speak = (u) => { synth.cancel(); u.onstart?.(); timer = setTimeout(() => u.onend?.(), 120); };
        synth.cancel = () => clearTimeout(timer);
    }, { books, locale });
    return context;
}

/** 量測浮動播放器的可見性、可點性與遮擋情況 */
const PROBE = () => {
    const bar = document.getElementById('floating-dictation-controls');
    if (!bar) return { present: false };
    const cs = getComputedStyle(bar);
    const r = bar.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    const top = document.elementFromPoint(cx, cy);
    const nav = document.querySelector('.app-nav');
    const navRect = nav ? nav.getBoundingClientRect() : null;
    const navFixedBottom = navRect && getComputedStyle(nav).position === 'fixed' && navRect.bottom >= innerHeight - 1;
    const overlapsNav = navFixedBottom ? r.bottom > navRect.top + 1 : false;
    const fab = document.getElementById('assistant-fab');
    const fabVisible = fab && getComputedStyle(fab).display !== 'none';
    const fabRect = fabVisible ? fab.getBoundingClientRect() : null;
    const overlapsFab = fabRect && !(r.right <= fabRect.left || r.left >= fabRect.right || r.bottom <= fabRect.top || r.top >= fabRect.bottom);
    const pauseBtn = document.getElementById('floating-pause-btn');
    const pbRect = pauseBtn ? pauseBtn.getBoundingClientRect() : null;
    const pauseHit = pauseBtn ? document.elementFromPoint(Math.round(pbRect.left + pbRect.width / 2), Math.round(pbRect.top + pbRect.height / 2)) : null;
    return {
        present: true,
        cls: bar.className,
        visibility: cs.visibility,
        opacity: cs.opacity,
        pointerEvents: cs.pointerEvents,
        zIndex: cs.zIndex,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        insideViewport: r.top >= -1 && r.left >= -1 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1,
        hitTestOk: !!top && !!top.closest('#floating-dictation-controls'),
        hitTestTarget: top ? (top.id || top.className || top.tagName) : null,
        overlapsBottomNav: overlapsNav,
        overlapsAssistantFab: !!overlapsFab,
        pauseButtonClickable: !!(pauseHit && pauseHit.closest('#floating-pause-btn')),
        viewport: { w: innerWidth, h: innerHeight }
    };
};

/** 收集當頁所有可見按鈕／圖標的顏色，用於找出離開設計令牌的色值 */
const ICON_AUDIT = () => {
    const rows = [];
    document.querySelectorAll('button, a, [role=button], .action-chip, .nav-btn').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return;
        const svg = el.querySelector('svg');
        const use = svg ? svg.querySelector('use') : null;
        const label = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20);
        rows.push({
            label,
            id: el.id || null,
            cls: String(el.className || '').slice(0, 44),
            text: cs.color,
            bg: cs.backgroundColor,
            border: cs.borderTopColor,
            hasIcon: !!svg,
            icon: use ? use.getAttribute('href') : (svg ? 'inline' : null),
            iconSize: svg ? `${Math.round(svg.getBoundingClientRect().width)}x${Math.round(svg.getBoundingClientRect().height)}` : null
        });
    });
    return rows;
};

// 四套配色主題的主色階都算合法令牌（modules/theme.js + styles.css 的 [data-theme] 區塊）
const TOKENS = {
    '#0f766e': 'primary', '#0d665f': 'primary-600', '#0b514c': 'primary-700',
    '#d5ebe7': 'primary-100', '#edf6f4': 'primary-050',
    '#4f46e5': 'primary', '#4338ca': 'primary-600', '#3730a3': 'primary-700',
    '#e3e1fb': 'primary-100', '#f1f0fd': 'primary-050',
    '#7c3aed': 'primary', '#6d28d9': 'primary-600', '#5b21b6': 'primary-700',
    '#ede9fe': 'primary-100', '#f5f3ff': 'primary-050',
    '#475569': 'primary', '#334155': 'primary-600', '#1e293b': 'primary-700',
    '#e2e8f0': 'primary-100', '#f1f5f9': 'primary-050',
    '#14161a': 'ink-900', '#22262c': 'ink-800', '#333941': 'ink-700', '#4a515b': 'ink-600',
    '#666e7a': 'ink-500', '#8a919c': 'ink-400', '#aeb4bd': 'ink-300',
    '#ffffff': 'surface', '#000000': 'none/transparent-black',
    '#f5f4f1': 'paper', '#efede8': 'paper-2', '#fbfaf8': 'surface-2', '#f3f2ee': 'surface-3',
    '#e7e4de': 'line', '#d5d1c9': 'line-strong',
    '#e08600': 'accent', '#b96b00': 'accent-600', '#fff5e3': 'accent-050',
    '#0f9e6b': 'ok', '#0b7d54': 'ok-600', '#e6f6f0': 'ok-050',
    '#d92d20': 'danger', '#b42318': 'danger-600', '#fdeceb': 'danger-050',
    '#2f6bd8': 'info', '#ecf1fd': 'info-050'
};

function hexToRgbString(hex) {
    const h = String(hex || '').replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const n = parseInt(full, 16);
    return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

// 允許每通道 ±2 的誤差：按鈕顏色有 transition，量測可能抓到過渡中的影格
function nearToken(hex) {
    if (TOKENS[hex]) return true;
    const parse = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const [r, g, b] = parse(hex);
    return Object.keys(TOKENS).some((token) => {
        const [tr, tg, tb] = parse(token);
        return Math.abs(r - tr) <= 2 && Math.abs(g - tg) <= 2 && Math.abs(b - tb) <= 2;
    });
}

function rgbToHex(rgb) {
    const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(rgb || '');
    if (!m) return null;
    if (m[4] !== undefined && Number(m[4]) === 0) return null; // 透明
    return '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
}

(async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        /* ============ A. 懸浮播放器：每個頁面、每個尺寸都要在 ============ */
        for (const [width, height] of VIEWPORTS) {
            const context = await newContext(browser, { width, height });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', (e) => errors.push(String(e)));
            await page.goto(BASE, { waitUntil: 'load' });
            await page.waitForTimeout(500);
            await openDictation(page);
            await page.locator('#start-dictation-btn').click();
            await page.waitForTimeout(600);

            for (const [alias, name] of PAGES) {
                await page.evaluate((a) => { location.hash = '#' + a; }, alias);
                await page.waitForTimeout(450);
                const s = await page.evaluate(PROBE);
                const label = `${width}x${height} ${name}`;
                check(`${label}：播放器存在`, s.present, s.present ? undefined : s);
                if (!s.present) continue;
                check(`${label}：可見且不透明`, s.visibility === 'visible' && s.opacity === '1' && s.pointerEvents !== 'none',
                    { visibility: s.visibility, opacity: s.opacity, pointerEvents: s.pointerEvents, cls: s.cls });
                check(`${label}：完整落在視窗內`, s.insideViewport, s.rect);
                check(`${label}：點擊命中播放器本身`, s.hitTestOk, { hit: s.hitTestTarget });
                check(`${label}：不遮擋底部導覽`, !s.overlapsBottomNav, s.rect);
                check(`${label}：不壓住 AI 助手按鈕`, !s.overlapsAssistantFab, { rect: s.rect, fab: s.overlapsAssistantFab });
                check(`${label}：暫停鍵可點`, s.pauseButtonClickable, s.rect);
                if (width === 390 || alias === 'a') {
                    await page.screenshot({ path: path.join(ASSETS, `verify-float-${width}x${height}-${alias}.png`), animations: 'disabled' });
                }
            }
            check(`${width}x${height}：巡檢過程無 JS 例外`, errors.length === 0, errors);
            await context.close();
        }

        /* ============ B. 圖標／按鈕配色：找出離開設計令牌的色值 ============ */
        const context = await newContext(browser, { width: 1440, height: 900 });
        const page = await context.newPage();
        await page.goto(BASE, { waitUntil: 'load' });
        await page.waitForTimeout(500);
        const offenders = [];
        const inventory = {};
        for (const [alias, name] of PAGES) {
            await page.evaluate((a) => { location.hash = '#' + a; }, alias);
            await page.waitForTimeout(400);
            const rows = await page.evaluate(ICON_AUDIT);
            for (const row of rows) {
                for (const key of ['text', 'bg', 'border']) {
                    const hex = rgbToHex(row[key]);
                    if (!hex) continue;
                    if (!nearToken(hex)) offenders.push({ page: name, where: key, hex, label: row.label, cls: row.cls });
                }
                if (row.icon) {
                    const k = `${row.hasIcon ? row.icon : 'no-icon'} ${row.iconSize}`;
                    inventory[k] = inventory[k] || { count: 0, sample: row.label };
                    inventory[k].count++;
                }
            }
        }
        results.report.tokenOffenders = offenders;
        results.report.iconInventory = inventory;
        check('圖標按鈕顏色全部落在設計令牌內', offenders.length === 0, offenders.slice(0, 25));

        /* ============ C. 設定彈窗內的開關／按鈕也要用同一套令牌 ============ */
        await page.click('#app-gear-btn');
        await page.waitForTimeout(300);
        await page.click('#gm-settings');
        await page.waitForTimeout(700);
        const modalRows = await page.evaluate(ICON_AUDIT);
        const modalSwitch = await page.evaluate(() => {
            const input = document.querySelector('#gs-assistant-enabled');
            if (!input) return null;
            input.checked = true;
            const sw = input.parentElement.querySelector('.gs-switch');
            const cs = getComputedStyle(sw);
            const primary = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();
            return { on: cs.backgroundColor, border: cs.borderTopColor, primary };
        });
        const modalOffenders = modalRows.flatMap((row) => ['text', 'bg', 'border']
            .map((key) => ({ key, hex: rgbToHex(row[key]) }))
            .filter((x) => x.hex && !nearToken(x.hex))
            .map((x) => ({ where: x.key, hex: x.hex, label: row.label, cls: row.cls })));
        results.report.modalOffenders = modalOffenders;
        check('設定彈窗控制項顏色落在設計令牌內', modalOffenders.length === 0, modalOffenders.slice(0, 15));
        check('設定彈窗開關「開啟」態使用主色', !!modalSwitch && modalSwitch.on === hexToRgbString(modalSwitch.primary),
            modalSwitch);
        await page.screenshot({ path: path.join(ASSETS, 'verify-settings-modal.png'), animations: 'disabled' });
        console.log('\n圖標尺寸／ sprite 分佈：', JSON.stringify(inventory, null, 2));
        if (offenders.length) {
            console.log('\n離開令牌的色值：');
            offenders.forEach((o) => console.log(`  ${o.page} ${o.where} ${o.hex}  ${o.label} (${o.cls})`));
        }
        await page.screenshot({ path: path.join(ASSETS, 'verify-icons-1440x900.png'), animations: 'disabled' });
        await context.close();

        /* ============ D. 文章段落狀態列：線性 sprite 圖標，不用 emoji ============ */
        const articleCtx = await newContext(browser, { width: 1280, height: 900 });
        const articlePage = await articleCtx.newPage();
        const articleErrors = [];
        articlePage.on('pageerror', (e) => articleErrors.push(String(e)));
        await articlePage.goto(BASE, { waitUntil: 'load' });
        await articlePage.waitForTimeout(500);
        await articlePage.evaluate(() => { location.hash = '#a'; });
        await articlePage.waitForTimeout(400);
        await articlePage.fill('#article-input', '# The School Garden\n\nOur school has a small garden behind the library.\n\nWe plant vegetables in spring and water them every morning.');
        await articlePage.click('#analyze-article-btn');
        await articlePage.waitForTimeout(1200);

        const statusRows = await articlePage.evaluate(() => [...document.querySelectorAll('.paragraph-pair .para-status')].map((row) => {
            const icon = row.querySelector('.status-icon');
            const use = icon ? icon.querySelector('use') : null;
            return {
                status: row.dataset.status,
                isSvg: !!use,
                href: use ? use.getAttribute('href') : null,
                glyph: icon ? icon.textContent.trim() : null
            };
        }));
        check('段落狀態列已渲染', statusRows.length > 0, statusRows.length);
        check('段落狀態圖標為站內 sprite（非 emoji 字元）',
            statusRows.length > 0 && statusRows.every((r) => r.isSvg && r.href === '#ic-timer' && r.glyph === ''),
            statusRows);

        const statusColors = await articlePage.evaluate(() => {
            const row = document.querySelector('.paragraph-pair .para-status');
            const icon = row.querySelector('.status-icon');
            const read = (state) => {
                row.dataset.status = state;
                const cs = getComputedStyle(icon);
                return cs.color;
            };
            const root = getComputedStyle(document.documentElement);
            return {
                done: read('done'),
                failed: read('failed'),
                okToken: root.getPropertyValue('--ok').trim(),
                dangerToken: root.getPropertyValue('--danger-600').trim()
            };
        });
        check('完成狀態圖標使用 --ok 綠色', statusColors.done === hexToRgbString(statusColors.okToken), statusColors);
        check('失敗狀態圖標使用 --danger-600', statusColors.failed === hexToRgbString(statusColors.dangerToken), statusColors);
        check('段落狀態流程無 JS 例外', articleErrors.length === 0, articleErrors);
        await articlePage.screenshot({ path: path.join(ASSETS, 'verify-article-status.png'), animations: 'disabled' });
        await articleCtx.close();

        /* ============ E. 靜態掃描：UI 檔案不得再出現彩色 emoji ============ */
        const emojiPattern = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2705}\u{274C}\u{26A0}\u{FE0F}]/u;
        const scanTargets = [];
        const collect = (dir, ext) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) collect(full, ext);
                else if (entry.name.endsWith(ext)) scanTargets.push(full);
            }
        };
        collect(path.resolve(__dirname, '..', 'features'), '.js');
        collect(path.resolve(__dirname, '..', 'locales'), '.js');
        scanTargets.push(path.resolve(__dirname, '..', 'index.html'));
        const emojiHits = [];
        for (const file of scanTargets) {
            fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
                const m = line.match(emojiPattern);
                // → / ➜ 屬單色文字箭號，不算彩色 emoji
                if (m && !'→➜'.includes(m[0])) {
                    emojiHits.push(`${path.relative(path.resolve(__dirname, '..'), file)}:${i + 1} ${m[0]}`);
                }
            });
        }
        check('UI 檔案不含彩色 emoji（只用 sprite 線性圖標）', emojiHits.length === 0, emojiHits.slice(0, 10));

        /* ============ F. 選中態不鋪滿主色；原生控件強調色跟主色 ============ */
        const colorCtx = await newContext(browser, { width: 1440, height: 900 });
        const colorPage = await colorCtx.newPage();
        await colorPage.goto(BASE, { waitUntil: 'load' });
        await colorPage.waitForTimeout(500);
        await colorPage.evaluate(() => { location.hash = '#d'; });
        await colorPage.waitForTimeout(400);
        const selection = await colorPage.evaluate(() => {
            const primary = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();
            const tint = getComputedStyle(document.documentElement).getPropertyValue('--primary-050').trim();
            const checked = document.querySelector('.radio-item-wrapper input:checked + .radio-label');
            const native = document.querySelector('input[type="radio"], input[type="range"]');
            const modeIcon = document.querySelector('.mode-choice input:checked ~ * .mode-icon, .mode-choice:has(input:checked) .mode-icon');
            const read = (el) => (el ? { bg: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color, border: getComputedStyle(el).borderTopColor } : null);
            return {
                primary, tint,
                checkedLabel: read(checked),
                modeIcon: read(modeIcon),
                accentColor: native ? getComputedStyle(native).accentColor : null
            };
        });
        check('選中的單詞本不再鋪滿主色（改淺底＋主色描邊）',
            !!selection.checkedLabel
            && selection.checkedLabel.bg === hexToRgbString(selection.tint)
            && selection.checkedLabel.border === hexToRgbString(selection.primary)
            && selection.checkedLabel.color !== 'rgb(255, 255, 255)',
            selection.checkedLabel);
        check('選中的練習方式圖標不再是實心主色',
            !!selection.modeIcon && selection.modeIcon.bg !== hexToRgbString(selection.primary),
            selection.modeIcon);
        check('原生控件（單選鈕／滑桿）強調色為主色',
            selection.accentColor === hexToRgbString(selection.primary),
            { accentColor: selection.accentColor, primary: selection.primary });
        await colorPage.screenshot({ path: path.join(ASSETS, 'verify-selection-tint.png'), animations: 'disabled' });
        await colorCtx.close();

        /* ============ G. AI 助手入口用「AI」二字 ============ */
        const fabCtx = await newContext(browser, { width: 1440, height: 900 });
        const fabPage = await fabCtx.newPage();
        await fabPage.goto(BASE, { waitUntil: 'load' });
        await fabPage.waitForTimeout(500);
        await fabPage.evaluate(() => { location.hash = '#a'; });
        await fabPage.waitForTimeout(600);
        const fab = await fabPage.evaluate(() => {
            const el = document.getElementById('assistant-fab');
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return {
                text: el.textContent.trim(),
                hasSvg: !!el.querySelector('svg'),
                w: Math.round(r.width), h: Math.round(r.height),
                radius: getComputedStyle(el).borderRadius
            };
        });
        check('AI 助手入口顯示「AI」二字且不含圖標', !!fab && fab.text === 'AI' && fab.hasSvg === false, fab);
        check('AI 助手入口為圓形可點區（>=46px）', !!fab && fab.w >= 46 && fab.h >= 46, fab);
        await fabPage.screenshot({ path: path.join(ASSETS, 'verify-ai-fab.png'), animations: 'disabled' });
        await fabCtx.close();

        /* ============ H. AI 助手面板：送出鈕不得被壓縮折行 ============ */
        for (const [mode, full, label] of [['floating', false, '浮動'], ['dock', true, '靠右全高'], ['modal', false, '大窗']]) {
            const panelCtx = await newContext(browser, { width: 1440, height: 900 });
            await panelCtx.addInitScript(({ mode, full }) => {
                localStorage.setItem('assistantModeMap', JSON.stringify({ global: mode, article: mode }));
                localStorage.setItem('assistantPanelFull', full ? '1' : '0');
            }, { mode, full });
            const panelPage = await panelCtx.newPage();
            await panelPage.goto(BASE, { waitUntil: 'load' });
            await panelPage.waitForTimeout(500);
            await panelPage.evaluate(() => { location.hash = '#a'; });
            await panelPage.waitForTimeout(500);
            await panelPage.click('#assistant-fab');
            await panelPage.waitForTimeout(600);
            const composer = await panelPage.evaluate(() => {
                const send = document.getElementById('assistant-send');
                if (!send) return null;
                const r = send.getBoundingClientRect();
                const range = document.createRange();
                range.selectNodeContents(send);
                const lines = range.getClientRects().length;
                const cs = getComputedStyle(send);
                return {
                    w: Math.round(r.width), h: Math.round(r.height), lines,
                    whiteSpace: cs.whiteSpace, flex: cs.flex,
                    overflows: Math.round(send.scrollWidth) > Math.round(send.clientWidth) + 1,
                    text: send.textContent.trim()
                };
            });
            check(`AI 面板（${label}）：送出鈕文字單行且不被壓縮`,
                !!composer && composer.lines === 1 && composer.w >= 60 && composer.overflows === false,
                composer);
            if (mode === 'dock') {
                await panelPage.screenshot({ path: path.join(ASSETS, 'verify-assistant-panel.png'), animations: 'disabled' });
            }
            await panelCtx.close();
        }

        /* ============ I. 匯入／合併單詞本：勾選框與卡片同一行 ============ */
        const vocabCtx = await newContext(browser, { width: 1440, height: 900 });
        await vocabCtx.addInitScript(() => {
            localStorage.setItem('vocabularyBooks', JSON.stringify([
                { id: 'b1', name: 'Unit 2 Terrible disasters', words: [{ id: 'w1', word: 'drought', meaning: '乾旱', phonetic: '/draʊt/' }] },
                { id: 'b2', name: 'Unit 3 Cooking is fun', words: [{ id: 'w2', word: 'recipe', meaning: '食譜', phonetic: '/ˈresəpi/' }] }
            ]));
            localStorage.setItem('activeBookId', 'b1');
        });
        const vocabPage = await vocabCtx.newPage();
        await vocabPage.goto(BASE, { waitUntil: 'load' });
        await vocabPage.waitForTimeout(600);
        await vocabPage.click('#vocabulary-btn');
        await vocabPage.waitForTimeout(300);
        await vocabPage.click('#import-vocab-book-btn');
        await vocabPage.waitForSelector('.import-preset-item', { timeout: 8000 }).catch(() => {});
        await vocabPage.waitForTimeout(400);
        const preset = await vocabPage.evaluate(() => {
            const item = document.querySelector('.import-preset-item');
            if (!item) return null;
            const cb = item.querySelector('.import-checkbox');
            const ri = item.getBoundingClientRect();
            const rc = cb ? cb.getBoundingClientRect() : null;
            const before = getComputedStyle(item).backgroundColor;
            if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
            const root = getComputedStyle(document.documentElement);
            return {
                nested: !!cb,
                insideItem: rc ? (rc.top >= ri.top - 1 && rc.bottom <= ri.bottom + 1 && rc.left >= ri.left - 1) : false,
                sameRow: rc ? Math.abs((rc.top + rc.height / 2) - (ri.top + ri.height / 2)) < 8 : false,
                before,
                afterBg: getComputedStyle(item).backgroundColor,
                afterBorder: getComputedStyle(item).borderTopColor,
                tint: root.getPropertyValue('--primary-050').trim(),
                primary: root.getPropertyValue('--primary').trim()
            };
        });
        check('匯入清單：勾選框與名稱同一張卡片、同一行',
            !!preset && preset.nested && preset.insideItem && preset.sameRow, preset);
        check('匯入清單：勾選後卡片套用主色高亮',
            !!preset && preset.afterBg === hexToRgbString(preset.tint) && preset.afterBorder === hexToRgbString(preset.primary),
            preset);
        await vocabPage.screenshot({ path: path.join(ASSETS, 'verify-import-presets.png'), animations: 'disabled' });
        await vocabCtx.close();

        const mergeCtx = await newContext(browser, { width: 1440, height: 900 });
        await mergeCtx.addInitScript(() => {
            localStorage.setItem('vocabularyBooks', JSON.stringify([
                { id: 'b1', name: 'Unit 2 Terrible disasters', words: [{ id: 'w1', word: 'drought', meaning: '乾旱', phonetic: '/draʊt/' }] },
                { id: 'b2', name: 'Unit 3 Cooking is fun', words: [{ id: 'w2', word: 'recipe', meaning: '食譜', phonetic: '/ˈresəpi/' }] },
                { id: 'b3', name: 'Unit 4 We like stories', words: [{ id: 'w3', word: 'story', meaning: '故事', phonetic: '/ˈstɔːri/' }] }
            ]));
            localStorage.setItem('activeBookId', 'b1');
        });
        const mergePage = await mergeCtx.newPage();
        await mergePage.goto(BASE, { waitUntil: 'load' });
        await mergePage.waitForTimeout(600);
        await mergePage.click('#vocabulary-btn');
        await mergePage.waitForTimeout(300);
        await mergePage.click('#merge-vocab-books-btn');
        await mergePage.waitForTimeout(800);
        const mergeItems = await mergePage.$$('.import-preset-item-wrapper');
        if (mergeItems[0]) await mergeItems[0].click();
        if (mergeItems[1]) await mergeItems[1].click();
        await mergePage.waitForTimeout(300);
        const mergeState = await mergePage.evaluate(() => {
            const wrappers = [...document.querySelectorAll('.import-preset-item-wrapper.selected')];
            const root = getComputedStyle(document.documentElement);
            return {
                selected: wrappers.length,
                cardBorder: wrappers[0] ? getComputedStyle(wrappers[0].querySelector('.import-preset-item')).borderTopColor : null,
                primary: root.getPropertyValue('--primary').trim(),
                counter: document.querySelector('#merge-selected-count')?.textContent
            };
        });
        check('合併清單：選中項有可見的主色高亮',
            mergeState.selected === 2 && mergeState.cardBorder === hexToRgbString(mergeState.primary), mergeState);
        await mergePage.screenshot({ path: path.join(ASSETS, 'verify-merge-selection.png'), animations: 'disabled' });
        await mergeCtx.close();

        /* ============ J. 全域設定：配色主題可切換並記住 ============ */
        const THEME_EXPECT = [
            ['teal', '#0f766e', '墨青'],
            ['indigo', '#4f46e5', '靛蓝'],
            ['violet', '#7c3aed', '紫罗兰'],
            ['slate', '#475569', '石墨']
        ];
        const themeCtx = await newContext(browser, { width: 1440, height: 900 });
        const themePage = await themeCtx.newPage();
        const themeErrors = [];
        themePage.on('pageerror', (e) => themeErrors.push(String(e)));
        await themePage.goto(BASE, { waitUntil: 'load' });
        await themePage.waitForTimeout(600);
        const initialTheme = await themePage.evaluate(() => ({
            theme: document.documentElement.dataset.theme,
            primary: getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()
        }));
        check('預設配色主題為墨青', initialTheme.theme === 'teal' && initialTheme.primary === '#0f766e', initialTheme);

        await themePage.click('#app-gear-btn');
        await themePage.waitForTimeout(300);
        await themePage.click('#gm-settings');
        await themePage.waitForTimeout(700);
        const picker = await themePage.$$eval('.gs-theme-btn', (els) => els.map((el) => ({
            id: el.getAttribute('data-theme-id'),
            text: el.textContent.trim(),
            active: el.classList.contains('active'),
            pressed: el.getAttribute('aria-pressed')
        })));
        check('設定彈窗有四個配色選項且標示目前主題',
            picker.length === 4 && picker.every((p, i) => p.id === THEME_EXPECT[i][0] && p.text === THEME_EXPECT[i][2])
            && picker.filter((p) => p.active).length === 1 && picker[0].pressed === 'true',
            picker);

        const applied = [];
        for (const [id, hex] of THEME_EXPECT) {
            await themePage.click(`.gs-theme-btn[data-theme-id="${id}"]`);
            await themePage.waitForTimeout(160);
            applied.push(await themePage.evaluate(() => ({
                theme: document.documentElement.dataset.theme,
                primary: getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(),
                meta: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
                faviconHasColor: (document.querySelector('link[rel="icon"]')?.getAttribute('href') || '')
                    .includes(encodeURIComponent(getComputedStyle(document.documentElement).getPropertyValue('--primary').trim())),
                active: document.querySelector('.gs-theme-btn.active')?.getAttribute('data-theme-id')
            })));
        }
        check('四套主題都能即時套用（主色／theme-color／favicon／選中態同步）',
            applied.every((row, i) => row.theme === THEME_EXPECT[i][0] && row.primary === THEME_EXPECT[i][1]
                && row.meta === THEME_EXPECT[i][1] && row.faviconHasColor && row.active === THEME_EXPECT[i][0]),
            applied);

        // 選靛藍 → 儲存 → 重新載入仍是靛藍
        await themePage.click('.gs-theme-btn[data-theme-id="indigo"]');
        await themePage.waitForTimeout(160);
        await themePage.screenshot({ path: path.join(ASSETS, 'verify-theme-picker.png'), animations: 'disabled' });
        await themePage.click('#gs-save');
        await themePage.waitForTimeout(900);
        const persisted = await themePage.evaluate(() => JSON.parse(localStorage.getItem('pen_global_settings') || '{}').theme);
        check('儲存後寫入 pen_global_settings.theme', persisted === 'indigo', persisted);
        await themePage.reload({ waitUntil: 'load' });
        await themePage.waitForTimeout(700);
        const afterReload = await themePage.evaluate(() => ({
            theme: document.documentElement.dataset.theme,
            primary: getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()
        }));
        check('重新載入後仍維持選擇的主題', afterReload.theme === 'indigo' && afterReload.primary === '#4f46e5', afterReload);
        await themePage.screenshot({ path: path.join(ASSETS, 'verify-theme-indigo.png'), animations: 'disabled' });
        check('切換主題過程無 JS 例外', themeErrors.length === 0, themeErrors);
        await themeCtx.close();

        /* ============ K. 聽寫懸浮窗：單詞列表可捲動 + 顯示內容可自訂 ============ */
        const bigBook = {
            id: 'float-book',
            name: 'Unit 2 Terrible disasters',
            words: Array.from({ length: 25 }, (_, i) => ({
                id: 'fw' + i, word: 'word' + (i + 1), meaning: '释义' + (i + 1), phonetic: '/wɜːd' + (i + 1) + '/'
            }))
        };
        const readFloating = () => {
            const bar = document.getElementById('floating-dictation-controls');
            const panel = document.getElementById('expand-panel');
            const container = document.querySelector('.word-list-container');
            const current = document.querySelector('.word-item.current');
            const list = document.getElementById('floating-word-list');
            const barRect = bar.getBoundingClientRect();
            const appBar = document.querySelector('.app-bar').getBoundingClientRect();
            const cr = container ? container.getBoundingClientRect() : null;
            const cur = current ? current.getBoundingClientRect() : null;
            const chipHit = (sel) => {
                const el = document.querySelector(sel);
                if (!el) return null;
                const r = el.getBoundingClientRect();
                const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
                return !!hit && !!hit.closest('#floating-dictation-controls');
            };
            return {
                expanded: panel ? getComputedStyle(panel).display !== 'none' : false,
                panelDisplay: panel ? getComputedStyle(panel).display : null,
                insideViewport: barRect.top >= appBar.bottom - 1 && barRect.bottom <= innerHeight + 1 && barRect.left >= -1,
                cardRect: { top: Math.round(barRect.top), bottom: Math.round(barRect.bottom) },
                scrollable: container ? container.scrollHeight > container.clientHeight + 1 : false,
                scrollTop: container ? Math.round(container.scrollTop) : null,
                currentVisible: (cr && cur) ? (cur.top >= cr.top - 1 && cur.bottom <= cr.bottom + 1) : null,
                currentIndex: current ? current.dataset.index : null,
                closeHit: chipHit('#expand-panel .close-btn'),
                chipHit: chipHit('.field-chip[data-field="word"]'),
                chips: [...document.querySelectorAll('.field-chip')].map((c) => ({
                    field: c.getAttribute('data-field'),
                    active: c.classList.contains('active'),
                    pressed: c.getAttribute('aria-pressed')
                })),
                emptyText: list?.querySelector('.word-list-empty')?.textContent.trim() || null,
                firstRow: list?.querySelector('.word-item')?.textContent.trim() || null,
                rowCount: list ? list.querySelectorAll('.word-item').length : 0
            };
        };

        for (const [w, h, label] of [[1440, 900, '桌面'], [390, 844, '手機'], [844, 390, '橫向矮視窗']]) {
            const floatCtx = await newContext(browser, { width: w, height: h });
            await floatCtx.addInitScript(({ bigBook }) => {
                localStorage.setItem('vocabularyBooks', JSON.stringify([bigBook]));
                localStorage.setItem('activeBookId', bigBook.id);
            }, { bigBook });
            const floatPage = await floatCtx.newPage();
            const floatErrors = [];
            floatPage.on('pageerror', (e) => floatErrors.push(String(e)));
            await floatPage.goto(BASE, { waitUntil: 'load' });
            await floatPage.waitForTimeout(600);
            await floatPage.evaluate(() => { location.hash = '#d'; });
            await floatPage.waitForTimeout(400);
            await floatPage.waitForSelector('#start-dictation-btn', { state: 'visible', timeout: 10000 });
            await floatPage.click('#start-dictation-btn');
            await floatPage.waitForTimeout(700);
            await floatPage.click('#floating-dictation-controls .info-area');
            await floatPage.waitForTimeout(500);

            const opened = await floatPage.evaluate(readFloating);
            check(`${label}：展開面板後單詞列表可捲動`, opened.expanded && opened.scrollable, opened);
            check(`${label}：展開後整張卡片仍在畫面內且標題列可點`,
                opened.insideViewport && opened.closeHit === true && opened.chipHit === true, opened);
            check(`${label}：預設只顯示序號與狀態`,
                opened.chips.filter((c) => c.active).map((c) => c.field).join(',') === 'index,status'
                && opened.firstRow.includes('#1') && !opened.firstRow.includes('word1'), opened.firstRow);

            // 播放前進後，列表要跟著捲動且當前單詞保持可見
            for (let i = 0; i < 10; i++) {
                await floatPage.click('#floating-next-btn');
                await floatPage.waitForTimeout(160);
            }
            await floatPage.waitForTimeout(700); // scrollIntoView 是平滑捲動，等它落定再量
            const advanced = await floatPage.evaluate(readFloating);
            check(`${label}：播放前進後列表自動捲動且當前單詞可見`,
                advanced.scrollTop > 0 && advanced.currentVisible === true && advanced.currentIndex === '10', advanced);

            // 全開 → 全關
            for (const field of ['word', 'phonetic', 'meaning']) {
                await floatPage.click(`.field-chip[data-field="${field}"]`);
                await floatPage.waitForTimeout(120);
            }
            const allOn = await floatPage.evaluate(readFloating);
            check(`${label}：開啟單詞／音標／釋義後列表顯示這些欄位`,
                allOn.chips.every((c) => c.active) && allOn.firstRow.includes('word1') && allOn.firstRow.includes('/wɜːd1/') && allOn.firstRow.includes('释义1'),
                allOn.firstRow);
            for (const field of ['index', 'status', 'word', 'phonetic', 'meaning']) {
                await floatPage.click(`.field-chip[data-field="${field}"]`);
                await floatPage.waitForTimeout(120);
            }
            const allOff = await floatPage.evaluate(readFloating);
            check(`${label}：全部關閉後整份列表隱藏（只有提示）`,
                allOff.rowCount === 0 && !!allOff.emptyText && allOff.chips.every((c) => !c.active), allOff);

            // 持久化：把「單詞」打開後重新載入，晶片狀態應一致
            await floatPage.click('.field-chip[data-field="word"]');
            await floatPage.waitForTimeout(200);
            const stored = await floatPage.evaluate(() => JSON.parse(localStorage.getItem('pen_dictation_settings') || '{}').floatListFields);
            await floatPage.reload({ waitUntil: 'load' });
            await floatPage.waitForTimeout(800);
            const restorePrompt = await floatPage.$('.options-modal-overlay #confirm-btn');
            if (restorePrompt) { await restorePrompt.click(); await floatPage.waitForTimeout(600); }
            await floatPage.click('#floating-dictation-controls .info-area').catch(() => {});
            await floatPage.waitForTimeout(500);
            const restored = await floatPage.evaluate(readFloating);
            const restoredFields = Object.fromEntries(restored.chips.map((c) => [c.field, c.active]));
            check(`${label}：顯示欄位設定會保存並在重新載入後還原`,
                !!stored && stored.word === true && restoredFields.word === true
                && Object.keys(stored).every((key) => restoredFields[key] === stored[key]),
                { stored, restoredFields });
            check(`${label}：懸浮窗流程無 JS 例外`, floatErrors.length === 0, floatErrors);
            if (label === '桌面') {
                await floatPage.screenshot({ path: path.join(ASSETS, 'verify-floating-fields.png'), animations: 'disabled' });
            }
            await floatCtx.close();
        }

        /* ============ L. AI 端點推導：相對路徑與 /v1 前綴都不可拼壞 ============ */
        const urlCtx = await newContext(browser, { width: 1280, height: 900 });
        const urlPage = await urlCtx.newPage();
        await urlPage.goto(BASE, { waitUntil: 'load' });
        await urlPage.waitForTimeout(600);
        const derivation = await urlPage.evaluate(async () => {
            const m = await import('/modules/ai-models.js');
            const cases = [
                ['http://127.0.0.1:3425/v1/chat/completions', 'http://127.0.0.1:3425/v1/models', 'http://127.0.0.1:3425/v1'],
                ['/v1/chat/completions', '/v1/models', '/v1'],
                ['https://tbai.xin/v1/chat/completions', 'https://tbai.xin/v1/models', 'https://tbai.xin/v1'],
                ['http://localhost:11434/v1/chat/completions', 'http://localhost:11434/v1/models', 'http://localhost:11434/v1']
            ];
            const providers = m.listAIProviders({}).filter((p) => p.id === 'default' || p.id === 'magpie')
                .map((p) => ({ id: p.id, apiUrl: p.apiUrl, modelsUrl: p.modelsUrl }));
            return {
                rows: cases.map(([apiUrl, modelsUrl, baseUrl]) => ({
                    apiUrl,
                    models: m.deriveModelsUrl({ apiUrl }),
                    modelsExpected: modelsUrl,
                    base: m.extractBaseUrlFromApiUrl(apiUrl),
                    baseExpected: baseUrl,
                    api: m.deriveApiUrl({ baseUrl })
                })),
                providers
            };
        });
        check('modelsUrl／baseUrl 推導正確（相對路徑與 /v1 前綴都不會拼成 /v1/v1/…）',
            derivation.rows.every((r) => r.models === r.modelsExpected && r.base === r.baseExpected && r.api === r.apiUrl),
            derivation.rows);
        // 真正的地雷是「寫死 127.0.0.1／localhost」：在手機或另一台電腦上，那會指向該裝置自己。
        // 相對路徑（同源代理）與可用的遠端端點都可以。
        check('內建 provider 沒有寫死 127.0.0.1／localhost（區域網其他裝置才連得上）',
            derivation.providers.length >= 1
            && derivation.providers.every((p) => !/^https?:\/\/(127\.0\.0\.1|localhost)/i.test(String(p.apiUrl || ''))),
            derivation.providers);
        await urlCtx.close();

        /* ============ M. 句末解析鍵：內嵌在段落裡 + 懸停聯動高亮與浮動提示 ============ */
        for (const [locale, viewport] of [['zh-HK', [1280, 900]], ['zh-CN', [1440, 900]]]) {
            const linkCtx = await newContext(browser, { width: viewport[0], height: viewport[1], locale });
            const linkPage = await linkCtx.newPage();
            const linkErrors = [];
            linkPage.on('pageerror', (e) => linkErrors.push(String(e)));
            // 文章分析走真實渲染路徑，只是把模型換成可預期的假回應
            await linkPage.route('**/v1/chat/completions', (route) => {
                let prompt = '';
                try { prompt = JSON.parse(route.request().postData()).messages[0].content || ''; } catch (_) { /* noop */ }
                const count = (prompt.match(/^\s*\d+\.\s/gm) || []).length;
                const content = count
                    ? { sentences: Array.from({ length: count }, (_, i) => `【中文譯句 ${i + 1}】第 ${i + 1} 句。`) }
                    : { chinese_translation: '（整段譯文）', word_alignment: [], detailed_analysis: [] };
                route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        id: 'mock', object: 'chat.completion', model: 'mock',
                        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }]
                    })
                });
            });
            await linkPage.goto(BASE, { waitUntil: 'load' });
            await linkPage.waitForTimeout(500);
            await linkPage.evaluate(() => { location.hash = '#a'; });
            await linkPage.waitForTimeout(300);
            await linkPage.fill('#article-input', [
                '# Reading Report',
                '',
                'The library opens at nine in the morning, and the reading room fills up quickly on weekdays. Many students arrive early to save a seat near the window.',
                '',
                '| Name | Books |',
                '| --- | --- |',
                '| Amy | Ten |'
            ].join('\n'));
            await linkPage.click('#analyze-article-btn');
            await linkPage.waitForSelector('.paragraph-pair .interactive-sentence', { timeout: 20000 });
            await linkPage.waitForTimeout(1500);

            const layout = await linkPage.evaluate(() => {
                const rows = [];
                document.querySelectorAll('.paragraph-pair:not(.is-title) .sentence-wrap').forEach((wrap) => {
                    const btn = wrap.querySelector('.sent-analyze-btn');
                    const sent = wrap.querySelector('.interactive-sentence');
                    const tail = wrap.querySelector('.sentence-tail');
                    // 量「最後一個詞 + 標點」的位置：按鈕已在 tail 內，範圍要排除按鈕本身
                    const range = document.createRange();
                    if (tail && tail.contains(btn) && tail.firstChild) {
                        range.setStartBefore(tail.firstChild);
                        range.setEndBefore(btn);
                    } else {
                        range.selectNodeContents(sent);
                    }
                    const rects = [...range.getClientRects()].filter((r) => r.width > 0);
                    const last = rects[rects.length - 1];
                    const b = btn.getBoundingClientRect();
                    const para = wrap.closest('.paragraph-english').getBoundingClientRect();
                    rows.push({
                        wrapDisplay: getComputedStyle(wrap).display,
                        btnPosition: getComputedStyle(btn).position,
                        hasTitleAttr: btn.hasAttribute('title'),
                        ariaLabel: btn.getAttribute('aria-label'),
                        tailWrapped: !!tail && tail.contains(btn),
                        tailNoWrap: tail ? getComputedStyle(tail).whiteSpace : null,
                        tailSingleLine: tail ? tail.getClientRects().length === 1 : null,
                        sameLineAsLastWord: last ? b.top < last.bottom - 2 : null,
                        gapAfterLastWord: last ? Math.round(b.left - last.right) : null,
                        farFromParagraphEdge: Math.round(para.right - b.right)
                    });
                });
                return rows;
            });
            check(`${locale}: 句末解析鍵內嵌在段落（wrap 為 inline、鍵為靜態定位）`,
                layout.length > 0 && layout.every((r) => r.wrapDisplay === 'inline' && r.btnPosition === 'static'),
                layout);
            check(`${locale}: 解析鍵與句尾最後一個詞綁成不可斷行的一組（不會孤行到下一行句首）`,
                layout.every((r) => r.tailWrapped && r.tailNoWrap === 'nowrap' && r.tailSingleLine === true),
                layout.map((r) => ({ bound: r.tailWrapped, ws: r.tailNoWrap, lines: r.tailSingleLine })));
            check(`${locale}: 解析鍵緊貼句尾最後一行（不再漂到段落右緣）`,
                layout.every((r) => r.sameLineAsLastWord === true && r.gapAfterLastWord !== null && r.gapAfterLastWord <= 8),
                layout.map((r) => ({ same: r.sameLineAsLastWord, gap: r.gapAfterLastWord, edge: r.farFromParagraphEdge })));
            check(`${locale}: 解析鍵不用原生 title（避免與站內浮動提示重複）`,
                layout.every((r) => r.hasTitleAttr === false && r.ariaLabel),
                layout.map((r) => r.ariaLabel));

            const btn = linkPage.locator('.paragraph-pair:not(.is-title) .sent-analyze-btn').first();
            await btn.hover();
            await linkPage.waitForTimeout(320);
            const hovered = await linkPage.evaluate(() => {
                const hint = document.querySelector('.sentence-hint');
                const btnEl = document.querySelector('.paragraph-pair:not(.is-title) .sent-analyze-btn');
                const b = btnEl.getBoundingClientRect();
                const h = hint ? hint.getBoundingClientRect() : null;
                const root = getComputedStyle(document.documentElement);
                const eng = document.querySelector('.interactive-sentence.sentence-linked');
                const zh = document.querySelector('.interactive-sentence-zh.sentence-linked');
                const overlap = (rects) => rects.reduce((sum, r) => {
                    const w = Math.min(h.right, r.right) - Math.max(h.left, r.left);
                    const k = Math.min(h.bottom, r.bottom) - Math.max(h.top, r.top);
                    return sum + (w > 0 && k > 0 ? w * k : 0);
                }, 0);
                const engRects = eng ? [...eng.getClientRects()].filter((r) => r.width > 0) : [];
                const zhRects = zh ? [...zh.getClientRects()].filter((r) => r.width > 0) : [];
                return {
                    linkedCount: document.querySelectorAll('.sentence-linked').length,
                    engText: eng ? eng.textContent.trim().slice(0, 18) : null,
                    zhText: zh ? zh.textContent.trim() : null,
                    bg: eng ? getComputedStyle(eng).backgroundColor : null,
                    shadow: eng ? getComputedStyle(eng).boxShadow : null,
                    btnOpacity: getComputedStyle(btnEl).opacity,
                    hintShown: !!hint && hint.classList.contains('is-shown'),
                    hintLabel: hint ? hint.querySelector('.sentence-hint-label').textContent : null,
                    hintText: hint ? hint.querySelector('.sentence-hint-text').textContent : null,
                    hintPlacement: hint ? hint.dataset.placement : null,
                    hintCoversLinkedSentence: h ? overlap(engRects) : null,
                    hintCoversTranslation: h ? overlap(zhRects) : null,
                    hintNearButton: !!(h && Math.min(Math.abs(h.top - b.bottom), Math.abs(b.top - h.bottom)) <= 48),
                    hintInViewport: !!(h && h.left >= 0 && h.top >= 0 && h.right <= innerWidth && h.bottom <= innerHeight),
                    tint: { primary100: root.getPropertyValue('--primary-100').trim(), primary600: root.getPropertyValue('--primary-600').trim() }
                };
            });
            check(`${locale}: 指向解析鍵時英文句與對應中文句同時加深`,
                hovered.linkedCount === 2
                && hovered.bg === hexToRgbString(hovered.tint.primary100)
                && hovered.shadow.includes(hexToRgbString(hovered.tint.primary600)),
                { count: hovered.linkedCount, bg: hovered.bg, shadow: hovered.shadow, tint: hovered.tint });
            check(`${locale}: 懸停浮動提示顯示該句中文譯文並落在畫面內`,
                hovered.hintShown && hovered.hintNearButton && hovered.hintInViewport
                && /中文譯句/.test(hovered.hintText || '') && !/^article\./.test(hovered.hintLabel || ''),
                { shown: hovered.hintShown, near: hovered.hintNearButton, inView: hovered.hintInViewport, label: hovered.hintLabel, text: hovered.hintText });
            check(`${locale}: 浮動提示不遮住它所指的那一句英文`,
                hovered.hintShown && hovered.hintCoversLinkedSentence === 0,
                { coveredArea: hovered.hintCoversLinkedSentence, translationArea: hovered.hintCoversTranslation, placement: hovered.hintPlacement });
            await linkPage.screenshot({ path: path.join(ASSETS, `verify-sentence-hover-${locale}.png`), animations: 'disabled' });

            await linkPage.mouse.move(4, 4);
            await linkPage.waitForTimeout(280);
            const cleared = await linkPage.evaluate(() => ({
                linked: document.querySelectorAll('.sentence-linked').length,
                hintShown: !!document.querySelector('.sentence-hint.is-shown')
            }));
            check(`${locale}: 移開後高亮與浮動提示都收乾淨`, cleared.linked === 0 && !cleared.hintShown, cleared);

            // 表格儲存格內的解析鍵也要能用（表格沒有右側熱區，靠的就是這顆鍵）
            const cellBtn = linkPage.locator('.md-table .sent-analyze-btn').first();
            if (await cellBtn.count()) {
                await cellBtn.hover();
                await linkPage.waitForTimeout(300);
                const cellState = await linkPage.evaluate(() => ({
                    linked: document.querySelectorAll('.sentence-linked').length,
                    hintShown: !!document.querySelector('.sentence-hint.is-shown')
                }));
                check(`${locale}: 表格儲存格內的解析鍵同樣有懸停聯動`, cellState.linked >= 1 && cellState.hintShown, cellState);
            }
            check(`${locale}: 句末解析鍵流程無 JS 例外`, linkErrors.length === 0, linkErrors);
            await linkCtx.close();
        }

        /* ============ N. 句子解析彈窗：窄螢幕不得把片語列撐出卡片外 ============ */
        const SENTENCE_FIXTURE = {
            sentence: 'It also brought challenges to the animal shelter run by Bright House.',
            translation: '这也给动物慈善机构「光明之家」所运营的动物收容所带来了挑战。',
            phrase_alignment: [
                { en: 'It also', zh: '这也' },
                { en: 'brought challenges to', zh: '给……带来了挑战' },
                { en: 'the animal shelter', zh: '动物收容所' },
                { en: 'run by Bright House', zh: '由「光明之家」运营的' }
            ],
            chunks: [
                { text: 'It also brought challenges', role: '主：主语 It 指代前文的暴雨，谓语 brought 表示带来，宾语 challenges', note: '核心结构是 bring sth to sb' },
                { text: 'to the animal shelter', role: '介词短语', note: '作 brought 的对象（对的动作象）对象，引出受影响的一方' },
                { text: 'run by Bright House', role: '后置定语', note: '过去分词短语，修饰 the animal shelter，意思是「由光明之家运营的」' }
            ],
            key_points: ['主句是 It brought challenges to the animal shelter', 'run by 是后置定语修饰 shelter']
        };
        const mockSentenceAi = (target) => target.route('**/v1/chat/completions', (route) => {
            let prompt = '';
            try { prompt = JSON.parse(route.request().postData()).messages[0].content || ''; } catch (_) { /* noop */ }
            let content;
            if (prompt.includes('phrase_alignment')) {
                content = prompt.includes('selection')
                    ? { meaning: '给……带来挑战', usage: 'bring sth to sb', examples: [{ en: 'The news brought joy to everyone.', zh: '这个消息给每个人带来了喜悦。' }] }
                    : SENTENCE_FIXTURE;
            } else {
                const count = (prompt.match(/^\s*\d+\.\s/gm) || []).length;
                content = count
                    ? { sentences: Array.from({ length: count }, () => '（譯句）') }
                    : { chinese_translation: '（整段譯文）', word_alignment: [], detailed_analysis: [] };
            }
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ id: 'mock', object: 'chat.completion', model: 'mock', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }] })
            });
        });

        for (const [label, width, height] of [['手機 390', 390, 844], ['手機 320', 320, 640], ['平板 768', 768, 1024], ['桌面 1280', 1280, 900]]) {
            const cardCtx = await newContext(browser, { width, height });
            const cardPage = await cardCtx.newPage();
            const cardErrors = [];
            cardPage.on('pageerror', (e) => cardErrors.push(String(e)));
            await mockSentenceAi(cardPage);
            await cardPage.goto(BASE, { waitUntil: 'load' });
            await cardPage.waitForTimeout(500);
            await cardPage.evaluate(() => { location.hash = '#a'; });
            await cardPage.waitForTimeout(300);
            await cardPage.fill('#article-input', [
                '# Bright House',
                '',
                "An unusual rainstorm hit Hong Kong last week. It also brought challenges to the animal shelter run by Bright House. Our school's Volunteering Club has already spent a day doing voluntary work there."
            ].join('\n'));
            await cardPage.click('#analyze-article-btn');
            await cardPage.waitForSelector('.paragraph-pair .sent-analyze-btn', { timeout: 20000 });
            await cardPage.waitForTimeout(1500);
            await cardPage.locator('.paragraph-pair:not(.is-title) .sent-analyze-btn').nth(1).click();
            await cardPage.waitForSelector('.sentence-card.is-modal .chunk-item', { timeout: 20000 });
            await cardPage.waitForTimeout(700);

            const cardDiag = await cardPage.evaluate(() => {
                const card = document.querySelector('.sentence-card.is-modal');
                const cardRect = card.getBoundingClientRect();
                const offenders = [...card.querySelectorAll('*')].filter((el) => {
                    const r = el.getBoundingClientRect();
                    return r.right > cardRect.right + 1 || el.scrollWidth > el.clientWidth + 2;
                }).map((el) => ({ cls: String(el.className).slice(0, 30), right: Math.round(el.getBoundingClientRect().right), cardRight: Math.round(cardRect.right) }));
                const squeezedButtons = [...card.querySelectorAll('button')].map((el) => {
                    const range = document.createRange();
                    range.selectNodeContents(el);
                    const lines = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0).length;
                    return { label: el.textContent.trim(), lines };
                }).filter((b) => b.lines > 1);
                return {
                    offenders,
                    squeezedButtons,
                    cardFitsViewport: Math.round(cardRect.right) <= innerWidth && Math.round(cardRect.left) >= 0,
                    pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                    chunkLines: [...card.querySelectorAll('.chunk-line')].map((el) => el.scrollWidth - el.clientWidth)
                };
            });
            check(`${label}：句子解析彈窗內的片語列不撐出卡片`,
                cardDiag.offenders.length === 0 && cardDiag.chunkLines.every((d) => d <= 2),
                cardDiag);
            check(`${label}：彈窗不造成整頁橫向捲動、按鈕文字不被擠成多行`,
                cardDiag.cardFitsViewport && cardDiag.pageOverflowX <= 0 && cardDiag.squeezedButtons.length === 0,
                { fits: cardDiag.cardFitsViewport, overflowX: cardDiag.pageOverflowX, squeezed: cardDiag.squeezedButtons });

            // 展開片語「詳解」，確認它與關閉鍵也留在卡片內
            await cardPage.locator('.sentence-card .chunk-explain').first().click();
            await cardPage.waitForTimeout(1200);
            const explainDiag = await cardPage.evaluate(() => {
                const box = document.querySelector('.phrase-explain-box');
                const card = document.querySelector('.sentence-card.is-modal');
                if (!box) return { present: false };
                const r = box.getBoundingClientRect();
                const closeBtn = box.querySelector('.phrase-close');
                const range = document.createRange();
                if (closeBtn) range.selectNodeContents(closeBtn);
                const lines = closeBtn ? [...range.getClientRects()].filter((x) => x.width > 0 && x.height > 0).length : 0;
                return { present: true, insideCard: r.right <= card.getBoundingClientRect().right + 1, inViewport: r.left >= -1 && r.right <= innerWidth + 1, closeLines: lines };
            });
            check(`${label}：片語詳解框與其關閉鍵留在卡片與畫面內`,
                explainDiag.present && explainDiag.insideCard && explainDiag.inViewport && explainDiag.closeLines === 1,
                explainDiag);
            check(`${label}：句子解析彈窗流程無 JS 例外`, cardErrors.length === 0, cardErrors);
            if (label === '手機 390' || label === '桌面 1280') {
                await cardPage.screenshot({ path: path.join(ASSETS, `verify-sentence-card-${width}.png`), animations: 'disabled' });
            }
            await cardCtx.close();
        }

        /* ============ O. 匯入管線：行內 Markdown、句子切分、長文分段清洗 ============ */
        {
            // O1. 純函式：行內 Markdown 轉換與分段切塊
            const fnCtx = await newContext(browser, { width: 1280, height: 900 });
            const fnPage = await fnCtx.newPage();
            await fnPage.goto(BASE, { waitUntil: 'load' });
            await fnPage.waitForTimeout(400);
            const fn = await fnPage.evaluate(async () => {
                const md = await import('/modules/markdown.js');
                const api = await import('/modules/api.js');
                const long = Array.from({ length: 12 }, (_, i) => `## Section ${i + 1}\n\n${'Body sentence. '.repeat(40)}`).join('\n\n');
                return {
                    bold: md.inlineMarkdownToHtml('It brought **serious challenges** here.'),
                    italic: md.inlineMarkdownToHtml('Use *italic* and _also italic_ and `const x = 1`.'),
                    link: md.inlineMarkdownToHtml('Read the [notice](https://example.com/n?utm=a) now.'),
                    badLink: md.inlineMarkdownToHtml('A [bad](javascript:alert(1)) link.'),
                    escaped: md.inlineMarkdownToHtml('Safe <script>alert(1)</script> text.'),
                    math: md.inlineMarkdownToHtml('Math 2 * 3 * 4 stays.'),
                    chunks: api.splitMarkdownForCleanup(long),
                    longLen: long.length
                };
            });
            check('行內 Markdown：粗體／斜體／行內程式碼都有對應標籤',
                /<strong>serious challenges<\/strong>/.test(fn.bold)
                && /<em>italic<\/em>/.test(fn.italic) && /<em>also italic<\/em>/.test(fn.italic) && /<code>const x = 1<\/code>/.test(fn.italic),
                { bold: fn.bold, italic: fn.italic });
            check('行內 Markdown：連結只留 anchor 文字，且過濾 javascript: 連結',
                /<a href="https:\/\/example\.com\/n\?utm=a"[^>]*>notice<\/a>/.test(fn.link) && fn.badLink === 'A [bad](javascript:alert(1)) link.',
                { link: fn.link, bad: fn.badLink });
            check('行內 Markdown：HTML 轉義、算式不被吃成斜體',
                fn.escaped.includes('&lt;script&gt;') && fn.math === 'Math 2 * 3 * 4 stays.',
                { escaped: fn.escaped, math: fn.math });
            check('長文會切成多塊（不再一次性送給模型）',
                fn.chunks.length >= 3 && fn.chunks.every((c) => c.length <= 3600),
                { count: fn.chunks.length, sizes: fn.chunks.map((c) => c.length), total: fn.longLen });
            await fnCtx.close();

            // O2. 端到端：長文清洗要分段送出，且尾段不能不見
            const pipeCtx = await newContext(browser, { width: 1280, height: 900 });
            const pipePage = await pipeCtx.newPage();
            let chatCalls = 0;
            await pipePage.route('**/v1/chat/completions', (route) => {
                chatCalls += 1;
                const body = JSON.parse(route.request().postData() || '{}');
                const promptText = (body.messages || []).map((m) => m.content).join('\n');
                // 原樣回傳這一塊：合併後若每一塊都被處理過，輸出就等於原文（尾塊不會不見）
                const source = promptText.split('=== Source Markdown ===')[1] || '';
                const firstLine = (source.split('=== End Source ===')[0] || '').trim();
                route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({ id: 'mock', object: 'chat.completion', model: 'mock', choices: [{ index: 0, message: { role: 'assistant', content: firstLine }, finish_reason: 'stop' }] })
                });
            });
            await pipePage.goto(BASE, { waitUntil: 'load' });
            await pipePage.waitForTimeout(500);
            const pipe = await pipePage.evaluate(async () => {
                const api = await import('/modules/api.js');
                const long = ['# Title', ''].concat(Array.from({ length: 12 }, (_, i) => `## Section ${i + 1}\n\n${'Body sentence. '.repeat(40)}`)).join('\n\n');
                const notices = [];
                const progress = [];
                const cleaned = await api.aiCleanArticleMarkdown(long, {
                    timeoutMs: 20000,
                    onNotice: (code) => notices.push(code),
                    onProgress: (done, total) => progress.push(`${done}/${total}`)
                });
                const chunks = api.splitMarkdownForCleanup(long);
                return { inLen: long.length, outLen: cleaned.length, notices, progress, chunks: chunks.length, cleaned };
            });
            check('長文清洗分段送出並回報進度',
                chatCalls >= 3 && pipe.progress.length === chatCalls && pipe.outLen > 0,
                { calls: chatCalls, progress: pipe.progress, outLen: pipe.outLen });
            check('每一塊都被清洗過、尾塊不會不見（不再被輸出上限砍掉）',
                pipe.notices.length === 0
                && pipe.chunks === chatCalls
                && /Section 1\b/.test(pipe.cleaned) && /Section 12\b/.test(pipe.cleaned)
                && pipe.outLen >= pipe.inLen * 0.9,
                { chunks: pipe.chunks, calls: chatCalls, inLen: pipe.inLen, outLen: pipe.outLen,
                  hasFirst: /Section 1\b/.test(pipe.cleaned), hasLast: /Section 12\b/.test(pipe.cleaned) });
            await pipeCtx.close();

            // O3. 文章詳解：行內 Markdown 要渲染，網址不能被切成兩句
            const mdCtx = await newContext(browser, { width: 1280, height: 900 });
            const mdPage = await mdCtx.newPage();
            const mdErrors = [];
            mdPage.on('pageerror', (e) => mdErrors.push(String(e)));
            const prompts = [];
            mdPage.on('request', (r) => {
                if (r.url().includes('/v1/chat/completions')) {
                    try { prompts.push(JSON.parse(r.postData()).messages.map((m) => m.content).join('\n')); } catch (_) {}
                }
            });
            await mockSentenceAi(mdPage);
            await mdPage.goto(BASE, { waitUntil: 'load' });
            await mdPage.waitForTimeout(500);
            await mdPage.evaluate(() => { location.hash = '#a'; });
            await mdPage.waitForTimeout(300);
            await mdPage.fill('#article-input', [
                '# Markdown Sample',
                '',
                'An unusual rainstorm hit Hong Kong, and it brought **serious challenges** to the shelter. Read the [official notice](https://example.com/notice?utm_source=rss) for details.'
            ].join('\n'));
            await mdPage.click('#analyze-article-btn');
            await mdPage.waitForFunction(() => [...document.querySelectorAll('.paragraph-pair .para-status')].every((s) => s.dataset.status !== 'pending'), null, { timeout: 40000 }).catch(() => {});
            await mdPage.waitForTimeout(600);
            const dom = await mdPage.evaluate(() => {
                const eng = document.querySelector('.paragraph-pair:not(.is-title) .paragraph-english');
                const sentences = [...eng.querySelectorAll('.interactive-sentence')].map((s) => s.dataset.sentence);
                const link = eng.querySelector('a');
                return {
                    hasStrong: !!eng.querySelector('strong'),
                    strongText: eng.querySelector('strong')?.textContent || '',
                    linkHref: link ? link.getAttribute('href') : null,
                    linkText: link ? link.textContent : null,
                    rawMarkers: /\*\*/.test(eng.textContent),
                    sentences,
                    sentenceCount: sentences.length
                };
            });
            check('文章詳解：粗體與連結渲染成標籤，不再顯示原始語法',
                dom.hasStrong && dom.strongText === 'serious challenges' && dom.linkText === 'official notice'
                && dom.linkHref === 'https://example.com/notice?utm_source=rss' && !dom.rawMarkers,
                dom);
            check('文章詳解：網址不會被切句器從 ? 處切成兩句',
                dom.sentenceCount === 2 && dom.sentences[1].includes('https://example.com/notice?utm_source=rss'),
                dom.sentences);
            check('送進模型的句子已去掉行內標記（譯文不會帶回 ** 或連結語法）',
                prompts.length > 0 && prompts.every((p) => !/\*\*/.test(p) && !/\[official notice\]\(/.test(p)),
                prompts.map((p) => (p.match(/^\d+\.\s.*$/gm) || []).slice(0, 3)));
            check('文章詳解 Markdown 流程無 JS 例外', mdErrors.length === 0, mdErrors);
            await mdCtx.close();
        }
    } finally {
        await browser.close();
    }

    results.report.summary = { total: results.checks.length, failed: results.failures.length };
    const out = path.resolve(__dirname, '..', 'docs', 'report', 'floating-player-and-icons.json');
    fs.writeFileSync(out, JSON.stringify(results.report, null, 2));
    console.log(`\n${results.checks.length - results.failures.length}/${results.checks.length} 通過；詳細結果：${out}`);
    process.exit(results.failures.length ? 1 : 0);
})();
