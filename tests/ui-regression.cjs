/**
 * DeepSeek 獨立 UI 方案 — 本輪個人複核回歸
 *
 * 覆蓋本輪實際改動：
 *  1. 選項彈窗／確認對話框改用設計權杖（不再有內聯樣式與舊藍色盤）
 *  2. 聽寫「恢復上次會話」改為站內對話框，「未選詞書 / 尚未開始」改為站內提示
 *  3. 聽寫浮動控制條：聽寫進行中在所有頁面、所有捲動位置都保持可見（不再自動收起）
 *  4. 平板（768/1024）導覽列晶片等高、單列、藥丸形
 *  5. OCR：原生檔案輸入改為設計一致的樣式、相機圖標改用 sprite、切換鈕有選中態
 *  6. 文章浮動朗讀列：統一 sprite 圖標 + 雙語標籤
 *  7. 雙語字典鍵集合一致
 *
 * 產出：docs/report/assets-ui-redesign/deepseek-round2-*.png 與結果摘要 JSON
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8313;
const BASE = `http://127.0.0.1:${PORT}/`;
const ASSETS = path.resolve(__dirname, '..', 'docs', 'report', 'assets-ui-redesign');
fs.mkdirSync(ASSETS, { recursive: true });

const books = [{
    id: 'audit-book',
    name: '五年级 · Daily words',
    words: [
        { id: 'audit-apple', word: 'apple', meaning: '苹果', phonetic: 'ˈæpl' },
        { id: 'audit-book-word', word: 'notebook', meaning: '笔记本', phonetic: 'ˈnəʊtbʊk' }
    ]
}];

const results = { variant: 'deepseek', round: 'personal-review', checks: [], failures: [], screenshots: [] };

function check(name, ok, detail) {
    results.checks.push({ name, ok: !!ok, detail });
    if (!ok) results.failures.push({ name, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`);
}

function newContext(browser, { locale, width, height }) {
    return browser.newContext({ viewport: { width, height } }).then(async (context) => {
        await context.route('**/*', (route) => {
            const url = new URL(route.request().url());
            return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
        });
        await context.addInitScript(({ books, locale }) => {
            localStorage.setItem('vocabularyBooks', JSON.stringify(books));
            localStorage.setItem('activeBookId', 'audit-book');
            localStorage.setItem('vocabImportPromptShown', '1');
            localStorage.setItem('pen_global_settings', JSON.stringify({ language: { interfaceLocale: locale }, assistant: { enabled: false } }));
            let timer;
            const synth = window.speechSynthesis;
            synth.speak = (u) => { window.__spoken = (window.__spoken || 0) + 1; synth.cancel(); u.onstart?.(); timer = setTimeout(() => u.onend?.(), 150); };
            synth.cancel = () => clearTimeout(timer);
            window.__native = [];
            const origAlert = window.alert, origConfirm = window.confirm;
            window.alert = (m) => { window.__native.push(['alert', String(m)]); };
            window.confirm = (m) => { window.__native.push(['confirm', String(m)]); return true; };
            window.__origAlert = origAlert; window.__origConfirm = origConfirm;
        }, { books, locale });
        return context;
    });
}

async function shot(page, name) {
    const file = path.join(ASSETS, `deepseek-round2-${name}.png`);
    await page.screenshot({ path: file, animations: 'disabled' });
    results.screenshots.push(path.relative(path.resolve(__dirname, '..'), file));
}

(async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        // ---------- 1 & 2：聽寫恢復對話框 + 站內提示 ----------
        for (const locale of ['zh-CN', 'zh-HK']) {
            const context = await newContext(browser, { locale, width: 390, height: 844 });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', (e) => errors.push(String(e)));
            await page.addInitScript(() => {
                localStorage.setItem('pen_dictation_session', JSON.stringify({
                    active: true, startTime: Date.now() - 60000, currentIndex: 1, isPaused: true,
                    words: [{ id: 'w1', word: 'apple', meaning: '苹果', phonetic: 'ˈæpl' }, { id: 'w2', word: 'notebook', meaning: '笔记本', phonetic: 'ˈnəʊtbʊk' }],
                    settings: { repeatTimes: 1, wordInterval: 5 }, timestamp: Date.now()
                }));
            });
            await page.goto(BASE, { waitUntil: 'load' });
            await page.waitForTimeout(700);

            const modal = page.locator('.options-modal-overlay .modal-content');
            // 站內對話框是初始化後才插入的，等它出現再判斷（固定等待曾經偶發落空）
            await modal.first().waitFor({ state: 'attached', timeout: 10000 }).catch(() => {});
            await page.waitForTimeout(300);
            const showedModal = await modal.count();
            check(`${locale}: 恢復提示為站內對話框（非原生 confirm）`, showedModal === 1, { count: showedModal });
            const nativeUsed = await page.evaluate(() => window.__native);
            check(`${locale}: 恢復流程未使用原生 alert/confirm`, nativeUsed.length === 0, nativeUsed);

            if (showedModal === 1) {
                const style = await page.evaluate(() => {
                    const overlay = document.querySelector('.options-modal-overlay');
                    const content = overlay.querySelector('.modal-content');
                    const cs = getComputedStyle(content);
                    const inlineCount = [...overlay.querySelectorAll('[style]')].length;
                    const btns = [...overlay.querySelectorAll('.modal-actions button')];
                    return {
                        overlayClass: overlay.className,
                        usesTokenShell: overlay.classList.contains('modal-overlay'),
                        bg: cs.backgroundColor,
                        radius: cs.borderRadius,
                        inlineStyleNodes: inlineCount,
                        injectedStyleTags: [...document.querySelectorAll('style')].filter(s => s.textContent.includes('.om-btn')).length,
                        buttons: btns.map(b => ({ text: b.textContent.trim(), cls: b.className, h: Math.round(b.getBoundingClientRect().height) })),
                        title: overlay.querySelector('h3').textContent.trim(),
                        legacyBlue: [...document.querySelectorAll('.options-modal-overlay *')].some(el => {
                            const c = getComputedStyle(el).backgroundColor;
                            return c === 'rgb(59, 130, 246)' || c === 'rgb(37, 99, 235)';
                        })
                    };
                });
                check(`${locale}: 對話框沿用站內 modal 外殼`, style.usesTokenShell, style);
                check(`${locale}: 對話框無內聯樣式節點`, style.inlineStyleNodes === 0, { inlineStyleNodes: style.inlineStyleNodes });
                check(`${locale}: 未注入一次性 <style>（原生 .om-btn 舊樣式）`, style.injectedStyleTags === 0, { tags: style.injectedStyleTags });
                check(`${locale}: 未殘留舊藍色盤 #3b82f6/#2563eb`, style.legacyBlue === false, { legacyBlue: style.legacyBlue });
                check(`${locale}: 兩顆按鈕為設計樣式且可點擊高度 >= 44`, style.buttons.length === 2 && style.buttons.every(b => b.h >= 44), style.buttons);
                check(`${locale}: 對話框標題已本地化`, locale === 'zh-CN' ? style.title.includes('听写') : style.title.includes('默書'), style.title);
                await shot(page, `restore-dialog-${locale}`);
                await page.locator('.options-modal-overlay #confirm-btn').click();
                await page.waitForTimeout(600);
                const restored = await page.evaluate(() => ({
                    section: document.querySelector('.module-section:not(.hidden)')?.id || null,
                    counter: document.querySelector('#dictation-counter-current')?.textContent,
                    playerVisible: !document.querySelector('#dictation-player').classList.contains('hidden')
                }));
                check(`${locale}: 確認後回到聽寫頁並還原進度 2/2`, restored.playerVisible && restored.counter === '2', restored);
                await page.locator('#stop-dictation-btn').click();
                await page.waitForTimeout(300);
            }
            check(`${locale}: 恢復流程無 JS 例外`, errors.length === 0, errors);
            await context.close();
        }

        // ---------- 2b：未選詞書 → 站內提示 ----------
        for (const locale of ['zh-CN', 'zh-HK']) {
            const context = await newContext(browser, { locale, width: 390, height: 844 });
            const page = await context.newPage();
            await page.goto(BASE, { waitUntil: 'load' });
            await page.waitForTimeout(400);
            await page.locator('#dictation-btn').click();
            await page.waitForTimeout(200);
            await page.evaluate(() => document.querySelectorAll('#dictation-book-selector input[type=radio]').forEach(r => { r.checked = false; }));
            await page.locator('#start-dictation-btn').click();
            await page.waitForTimeout(400);
            const toast = await page.evaluate(() => {
                const el = document.querySelector('#message-container .message-toast');
                if (!el) return null;
                const r = el.getBoundingClientRect();
                const cs = getComputedStyle(el);
                const nav = document.querySelector('.app-nav');
                const navRect = nav.getBoundingClientRect();
                return {
                    text: el.textContent.trim(), cls: el.className,
                    bottom: Math.round(r.bottom), right: Math.round(r.right),
                    navTop: Math.round(navRect.top),
                    bg: cs.backgroundColor, radius: cs.borderRadius,
                    role: el.getAttribute('role'), vw: innerWidth
                };
            });
            check(`${locale}: 未選詞書顯示站內提示（非原生 alert）`, !!toast, toast);
            if (toast) {
                check(`${locale}: 提示為 warning 類型且不遮擋底部導覽`, toast.cls.includes('message-warning') && toast.bottom <= toast.navTop + 1, { bottom: toast.bottom, navTop: toast.navTop });
            }
            const native = await page.evaluate(() => window.__native);
            check(`${locale}: 未選詞書未觸發原生 alert`, native.length === 0, native);
            await shot(page, `toast-no-book-${locale}`);
            await context.close();
        }

        // ---------- 3：聽寫浮動控制條顯隱 ----------
        for (const [width, height] of [[390, 844], [768, 1024], [1024, 768], [1440, 900]]) {
            const context = await newContext(browser, { locale: 'zh-CN', width, height });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', (e) => errors.push(String(e)));
            await page.goto(BASE, { waitUntil: 'load' });
            await page.waitForTimeout(400);
            await page.locator('#dictation-btn').click();
            await page.waitForTimeout(400);
            await page.locator('#start-dictation-btn').click();
            await page.waitForTimeout(500);

            const state = async () => page.evaluate(() => {
                const bar = document.querySelector('#floating-dictation-controls');
                const controls = document.querySelector('#dictation-player .player-controls');
                const r = controls.getBoundingClientRect();
                const visible = Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top));
                const cs = bar ? getComputedStyle(bar) : null;
                return {
                    present: !!bar,
                    veiled: bar ? bar.classList.contains('is-veiled') : null,
                    visibility: cs?.visibility, opacity: cs?.opacity,
                    ratio: +(visible / r.height).toFixed(3),
                    scrollY: Math.round(window.scrollY),
                    canScroll: document.documentElement.scrollHeight > innerHeight + 1
                };
            });

            // 不變式（自 98f28de 起）：聽寫進行中，浮動播放器在任何捲動位置、任何頁面都保持可見，
            // 不再依「頁內控制列是否離開畫面」自動隱藏（is-veiled 已移除）
            const positions = [['頂部', 0], ['中段', 0.5], ['底部', 1]];
            // 逐位置比對可見性
            for (const [label, frac] of positions) {
                await page.evaluate((f) => window.scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * f), frac);
                await page.waitForTimeout(450);
                const s = await state();
                if (label === '頂部') {
                    check(`${width}x${height}: 開始後浮動條存在`, s.present, s);
                }
                check(`${width}x${height}: ${label}（控制項可見率 ${s.ratio}）浮動條保持可見`, s.present && s.visibility === 'visible' && s.opacity === '1', s);
                if (label === '底部') await shot(page, `dictation-floating-bottom-${width}x${height}`);
            }


            await page.evaluate(() => window.scrollTo(0, 0));
            await page.waitForTimeout(350);
            await page.locator('#stop-dictation-btn').click();
            await page.waitForTimeout(400);
            const afterStop = await page.evaluate(() => document.querySelectorAll('#floating-dictation-controls').length);
            check(`${width}x${height}: 停止後浮動條移除`, afterStop === 0, { count: afterStop });
            const overflow = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth }));
            check(`${width}x${height}: 無橫向溢出`, overflow.sw <= overflow.w + 1, overflow);
            check(`${width}x${height}: 無 JS 例外`, errors.length === 0, errors);
            await context.close();
        }

        // ---------- 4：平板／桌機導覽列 ----------
        for (const [width, height] of [[768, 1024], [1024, 768], [1440, 900]]) {
            const context = await newContext(browser, { locale: 'zh-CN', width, height });
            const page = await context.newPage();
            await page.goto(BASE, { waitUntil: 'load' });
            await page.waitForTimeout(400);
            const nav = await page.evaluate(() => {
                const nav = document.querySelector('.app-nav');
                const btns = [...nav.querySelectorAll('.nav-btn')].filter(b => b.offsetParent !== null);
                const rects = btns.map(b => b.getBoundingClientRect());
                const cs = btns.map(b => getComputedStyle(b));
                const sidebar = getComputedStyle(nav).flexDirection === 'column';
                return {
                    layout: sidebar ? 'sidebar' : 'top-row',
                    count: btns.length,
                    heights: [...new Set(rects.map(r => Math.round(r.height)))],
                    widths: [...new Set(rects.map(r => Math.round(r.width)))],
                    tops: [...new Set(rects.map(r => Math.round(r.top)))],
                    radius: [...new Set(cs.map(c => c.borderRadius))],
                    fontSizes: [...new Set(cs.map(c => c.fontSize))],
                    backgrounds: [...new Set(btns.filter(b => !b.classList.contains('active')).map(b => getComputedStyle(b).backgroundColor))]
                };
            });
            const layout = nav.layout;
            check(`${width}x${height}: ${layout} 七個導覽項全數顯示`, nav.count === 7, nav);
            if (layout === 'sidebar') {
                check(`${width}x${height}: sidebar 導覽項等高且等寬`, nav.heights.length === 1 && nav.widths.length === 1, { heights: nav.heights, widths: nav.widths });
            } else {
                check(`${width}x${height}: top-row 導覽晶片等高`, nav.heights.length === 1 && nav.heights[0] <= 46, nav.heights);
            }
            check(`${width}x${height}: ${layout} 導覽項圓角與字級一致`, nav.radius.length === 1 && nav.fontSizes.length === 1, { radius: nav.radius, fontSizes: nav.fontSizes });
            if (layout === 'top-row') {
                check(`${width}x${height}: 頂部列所有晶片同一列且為藥丸形`, nav.tops.length === 1 && nav.heights[0] <= 46 && parseFloat(nav.radius[0]) >= 20, nav);
            }
            check(`${width}x${height}: 未選中項為透明底`, nav.backgrounds.every(c => c === 'rgba(0, 0, 0, 0)'), nav.backgrounds);
            await shot(page, `nav-${layout}-${width}x${height}`);
            await context.close();
        }

        // ---------- 5：OCR 檔案輸入與相機圖標 ----------
        {
            const context = await newContext(browser, { locale: 'zh-CN', width: 390, height: 844 });
            const page = await context.newPage();
            await page.goto(`${BASE}?module=ocr`, { waitUntil: 'load' });
            await page.waitForTimeout(400);
            const ocr = await page.evaluate(() => {
                const input = document.querySelector('#ocr-image-input');
                const cam = document.querySelector('#ocr-open-camera-btn');
                const toggle = document.querySelector('#ocr-prefer-toggle');
                const stop = document.querySelector('#ocr-stop-btn');
                const useOf = (el) => el?.querySelector('use')?.getAttribute('href') || null;
                const inlineSvg = [...document.querySelectorAll('#ocr-section svg')].filter(s => !s.querySelector('use') && !s.classList.contains('icon-sprite'));
                return {
                    inputPresent: !!input,
                    inputReadyOnly: input ? input.value === '' : null,
                    camIcon: useOf(cam),
                    toggleIcon: useOf(toggle),
                    stopIcon: useOf(stop),
                    inlineSvgCount: inlineSvg.length,
                    fileButtonRadius: input ? getComputedStyle(input, '::file-selector-button').borderRadius : null,
                    fileButtonBg: input ? getComputedStyle(input, '::file-selector-button').backgroundColor : null,
                    togglePressed: toggle?.getAttribute('aria-pressed'),
                    toggleActiveBg: toggle ? getComputedStyle(toggle).backgroundColor : null
                };
            });
            check('OCR: 相機與停止圖標改用 sprite', ocr.camIcon === '#ic-camera' && ocr.toggleIcon === '#ic-camera' && ocr.stopIcon === '#ic-stop', ocr);
            check('OCR: 區塊內無非 sprite 的行內 SVG', ocr.inlineSvgCount === 0, { count: ocr.inlineSvgCount });
            check('OCR: 檔案輸入按鈕使用設計樣式', ocr.fileButtonRadius !== '0px' && ocr.fileButtonBg !== 'rgb(239, 239, 239)', { radius: ocr.fileButtonRadius, bg: ocr.fileButtonBg });
            check('OCR: 相機優先鈕有 aria-pressed 初始值', ocr.togglePressed === 'false', { pressed: ocr.togglePressed });
            await page.locator('#ocr-prefer-toggle').click();
            // 等選中類別真的套上（CSS transition 期間量到的會是過渡中的顏色）
            await page.waitForFunction(() => document.querySelector('#ocr-prefer-toggle')?.classList.contains('active'), null, { timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(300);
            const toggled = await page.evaluate(() => {
                const toggle = document.querySelector('#ocr-prefer-toggle');
                return { pressed: toggle.getAttribute('aria-pressed'), active: toggle.classList.contains('active'), bg: getComputedStyle(toggle).backgroundColor, border: getComputedStyle(toggle).borderColor };
            });
            check('OCR: 相機優先鈕切換後有可見選中態', toggled.active && toggled.pressed === 'true' && toggled.bg !== 'rgb(255, 255, 255)', toggled);
            await shot(page, 'ocr-mobile');
            await context.close();
        }

        // ---------- 6：文章浮動朗讀列 ----------
        for (const [locale, viewport] of [['zh-CN', [390, 844]], ['zh-HK', [768, 1024]]]) {
            const context = await newContext(browser, { locale, width: viewport[0], height: viewport[1] });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', (e) => errors.push(String(e)));
            await page.goto(`${BASE}?module=article`, { waitUntil: 'load' });
            await page.waitForTimeout(400);
            await page.fill('#article-input', 'The little fox lives near the river. It likes apples and milk. Every morning it walks to the hill.');
            await page.locator('#read-article-btn').click();
            await page.waitForTimeout(600);
            const reader = await page.evaluate(() => {
                const el = document.querySelector('.floating-reader');
                if (!el) return { present: false };
                const btns = [...el.querySelectorAll('.fr-btn')];
                const r = el.getBoundingClientRect();
                const nav = document.querySelector('.app-nav');
                const navRect = nav.getBoundingClientRect();
                const navFixed = getComputedStyle(nav).position === 'fixed';
                return {
                    present: true,
                    count: btns.length,
                    spriteIcons: btns.filter(b => b.querySelector('use')).length,
                    labels: btns.map(b => b.title),
                    uses: btns.map(b => b.querySelector('use')?.getAttribute('href')),
                    handleIsSvg: !!el.querySelector('.fr-handle use'),
                    bottom: Math.round(r.bottom),
                    navTop: navFixed ? Math.round(navRect.top) : null,
                    w: Math.round(r.width), vw: innerWidth
                };
            });
            check(`${locale}: 朗讀列使用統一 sprite 圖標（7 顆）`, reader.present && reader.count === 7 && reader.spriteIcons === 7, reader);
            check(`${locale}: 朗讀列拖曳把手為 sprite 圖標`, reader.handleIsSvg === true);
            const readerClose = locale === 'zh-HK' ? '關閉' : '关闭';
            const readerPrev = locale === 'zh-HK' ? '上一句' : '上一句';
            check(`${locale}: 朗讀列標籤已本地化（無未翻譯鍵）`, reader.present
                && reader.labels.every(l => l && !/^article\./.test(l))
                && reader.labels.includes(readerClose) && reader.labels.includes(readerPrev), reader.labels);
            check(`${locale}: 朗讀列不遮擋底部導覽`, reader.navTop === null || reader.bottom <= reader.navTop + 1, { bottom: reader.bottom, navTop: reader.navTop });
            check(`${locale}: 朗讀列寬度未超出視窗`, reader.w <= reader.vw - 8, { w: reader.w, vw: reader.vw });
            await shot(page, `reader-${locale}`);
            await page.locator('.floating-reader .fr-en').click();
            await page.locator('.floating-reader .fr-follow').click();
            await page.waitForTimeout(300);
            const toggled = await page.evaluate(() => {
                const el = document.querySelector('.floating-reader');
                const en = el.querySelector('.fr-en'), fw = el.querySelector('.fr-follow');
                return {
                    enIcon: en.querySelector('use').getAttribute('href'),
                    enActive: en.classList.contains('active'), enPressed: en.getAttribute('aria-pressed'),
                    followActive: fw.classList.contains('active'), followPressed: fw.getAttribute('aria-pressed')
                };
            });
            check(`${locale}: 僅顯示英文切換有圖標與狀態回饋`, toggled.enIcon === '#ic-eye-off' && toggled.enActive && toggled.enPressed === 'true', toggled);
            check(`${locale}: 跟隨滾動切換有狀態回饋`, toggled.followPressed === 'false', toggled);
            await shot(page, `reader-toggled-${locale}`);
            check(`${locale}: 朗讀流程無 JS 例外`, errors.length === 0, errors);
            await context.close();
        }

        // ---------- 7：字典鍵一致性 ----------
        const localeCheck = await (async () => {
            const cn = (await import('../locales/zh-CN.js')).default;
            const hk = (await import('../locales/zh-HK.js')).default;
            const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object') ? flat(v, `${p}${k}.`) : [`${p}${k}`]);
            const a = new Set(flat(cn)), b = new Set(flat(hk));
            return { cn: a.size, hk: b.size, onlyCN: [...a].filter(k => !b.has(k)), onlyHK: [...b].filter(k => !a.has(k)) };
        })();
        check('雙語字典鍵集合一致', localeCheck.onlyCN.length === 0 && localeCheck.onlyHK.length === 0, localeCheck);

        // ---------- 8：靜態掃描 — UI 不得再出現寫死的中文／寫死的語言 ----------
        const audit = (() => {
            const CJK = /[\u4e00-\u9fff]/;
            // 這些檔案本來就該有中文（字典、AI 提示詞、語系設定、語音比對啟發式）
            const SKIP_FILES = new Set([
                'locales/zh-CN.js', 'locales/zh-HK.js', 'ai-config.js', 'ai-config.example.js',
                'modules/i18n-config.js', 'modules/prompts/index.js', 'modules/prompts/language-rules.js',
                'modules/audio.js', 'modules/voices.js', 'modules/vocab.js'
            ]);
            const SKIP_DIRS = new Set(['locales', 'node_modules', '.git', 'docs', 'tests', 'scripts', 'phonetic-chart', 'modules/prompts']);
            const walk = (dir, out = []) => {
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                    if (entry.name.startsWith('.')) continue;
                    const full = path.join(dir, entry.name);
                    const rel = path.relative(path.resolve(__dirname, '..'), full);
                    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(full, out); continue; }
                    if (entry.name.endsWith('.js') && !SKIP_FILES.has(rel)) out.push(full);
                }
                return out;
            };
            const root = path.resolve(__dirname, '..');
            const hardcoded = [];
            const hardcodedLocale = [];
            const stripComments = (line) => line.replace(/\/\/.*$/, '');
            for (const file of walk(root)) {
                const rel = path.relative(root, file);
                const lines = fs.readFileSync(file, 'utf8').split('\n');
                let inBlockComment = false;
                lines.forEach((raw, i) => {
                    // 區塊註解（/* ... */ 與其後的 * 行）不算程式碼
                    if (inBlockComment) {
                        if (raw.includes('*/')) inBlockComment = false;
                        return;
                    }
                    if (raw.includes('/*') && !raw.includes('*/')) { inBlockComment = true; return; }
                    if (raw.trim().startsWith('*')) return;
                    // 明確標記「這裡刻意保留中文」的行（含前一行註解標記）
                    if (/i18n-allow/.test(raw) || /i18n-allow/.test(lines[i - 1] || '')) return;
                    const line = stripComments(raw);
                    if (/console\./.test(line)) return;
                    // 去掉 t('...') 之後再看還有沒有中文字串
                    const withoutI18n = line.replace(/\bt\(\s*(['"`])[\s\S]*?\1\s*(?:,[^)]*)?\)/g, 't()');
                    if (!CJK.test(withoutI18n)) return;
                    // 只抓字串字面值或 HTML 屬性裡的中文，純註解／純識別字不算
                    if (!/(['"`])[^'"`]*[\u4e00-\u9fff]/.test(withoutI18n)) return;
                    hardcoded.push(`${rel}:${i + 1}: ${raw.trim().slice(0, 90)}`);
                });
                const src = fs.readFileSync(file, 'utf8');
                const badLocale = src.match(/toLocaleString\(\s*(['"])zh|Intl\.Collator\(\s*(['"])zh|toLocaleDateString\(\s*(['"])zh/g);
                if (badLocale) hardcodedLocale.push(`${rel}: ${badLocale.join(', ')}`);
            }
            // index.html：標籤屬性裡的中文必須有對應的 data-i18n-*
            const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
            const attrIssues = [];
            const tagRe = /<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
            let m;
            while ((m = tagRe.exec(html))) {
                const tagText = m[0];
                const attrRe = /([\w-]+)\s*=\s*"([^"]*)"/g;
                let a;
                while ((a = attrRe.exec(tagText))) {
                    const [, name, value] = a;
                    if (!['title', 'aria-label', 'placeholder', 'value', 'alt'].includes(name)) continue;
                    if (!CJK.test(value)) continue;
                    const key = `data-i18n-${name === 'aria-label' ? 'aria-label' : name}`;
                    if (!tagText.includes(key)) attrIssues.push(`<${m[1]} ${name}="${value.slice(0, 30)}">`);
                }
            }
            return { hardcoded, hardcodedLocale, attrIssues };
        })();
        check('原始碼沒有寫死的中文 UI 字串（一律走 t()）',
            audit.hardcoded.length === 0, audit.hardcoded.slice(0, 8));
        check('沒有寫死的語言（toLocaleString / Intl.Collator 不帶 zh-*）',
            audit.hardcodedLocale.length === 0, audit.hardcodedLocale);
        check('index.html 的中文屬性都接上 data-i18n-*',
            audit.attrIssues.length === 0, audit.attrIssues.slice(0, 8));
    } catch (error) {
        results.failures.push({ name: 'harness', detail: String(error && error.stack || error) });
        console.error(error);
    } finally {
        await browser.close();
    }

    const summaryFile = path.resolve(__dirname, '..', 'docs', 'report', 'root-audit', 'deepseek-round2.json');
    fs.mkdirSync(path.dirname(summaryFile), { recursive: true });
    fs.writeFileSync(summaryFile, JSON.stringify(results, null, 2));
    console.log(`\n== ${results.checks.filter(c => c.ok).length}/${results.checks.length} checks passed ==`);
    if (results.failures.length) {
        console.error('FAILURES:', JSON.stringify(results.failures, null, 2));
        process.exit(1);
    }
})();
