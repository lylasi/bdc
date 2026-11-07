#!/usr/bin/env node
/**
 * V4 對照組（control）：把「V4 的操作區扣減」這段在『該頁的請求』中還原成 V3 行為，
 * 用來證明 320×720 空詞書「最後一項被底部導覽蓋住」確實是這段修正造成的差異。
 *
 * 做法：Playwright route 攔 features/vocabulary/vocabulary.js，把 positionWordPanelMenu 內
 *       「依 appBar / appNav 實際矩形求 viewportTop / viewportBottom」的兩行拿掉，
 *       於是 viewportTop=0、viewportBottom=window.innerHeight（＝V3 的算法）。
 *       不修改磁碟上的正式程式碼。
 *
 * 用法：PORT=8313 PLAYWRIGHT_MODULE=<playwright> node <此檔>
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = '/Users/linus/CODE/bdc';
const PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${PORT}/`;
const ASSET_DIR = __dirname;
const SHOTS = path.join(ASSET_DIR, 'shots');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const MOCK = `export const AI_LIMITS={default:{maxConcurrency:1,minIntervalMs:400}};
export const TTS_CONFIG={baseUrl:'',baseUrlRemote:'',baseUrlLocal:'',use:'remote',voicesUrl:'',apiKey:'',voices:{}};
export const OCR_CONFIG={DEFAULT_MODEL:''};
export const ARTICLE_IMPORT={FEED_URL:'',PROXY_URL:'',SOURCES:[]};
export const SYNC={};export const SUPABASE={};`;

const V3_PATCH_FROM = `        if (bounds.top < window.innerHeight / 2) viewportTop = Math.max(viewportTop, bounds.bottom);
        else viewportBottom = Math.min(viewportBottom, bounds.top);`;
const V3_PATCH_TO = `        // (V3 control) 不扣減頂欄／底欄高度：viewportTop=0, viewportBottom=innerHeight`;

const PROBE = () => {
    const menu = document.getElementById('word-panel-menu');
    const nav = document.querySelector('.app-nav');
    const br = document.querySelector('.app-bar').getBoundingClientRect();
    const nr = nav.getBoundingClientRect();
    menu.scrollTop = menu.scrollHeight;
    const items = Array.from(menu.querySelectorAll('.menu-item'));
    const last = items[items.length - 1];
    const r = last.getBoundingClientRect();
    const mr = menu.getBoundingClientRect();
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const top = (cy > 0 && cy < innerHeight) ? document.elementFromPoint(cx, cy) : null;
    return {
        barBottom: +br.bottom.toFixed(1),
        navTop: +nr.top.toFixed(1),
        innerHeight,
        menu: { y: +mr.y.toFixed(1), bottom: +mr.bottom.toFixed(1), h: +mr.height.toFixed(1), maxHeight: menu.style.maxHeight, scrollHeight: menu.scrollHeight, clientHeight: menu.clientHeight },
        lastItem: { text: last.textContent.trim(), y: +r.y.toFixed(1), bottom: +r.bottom.toFixed(1), centerY: +cy.toFixed(1) },
        lastItemHitTag: top ? `${top.tagName}.${String(top.className || '').slice(0, 26)}` : '(null)',
        lastItemHitSelf: !!(top && (top === last || last.contains(top)))
    };
};

(async () => {
    fs.mkdirSync(SHOTS, { recursive: true });
    const build = execSync('md5 -q features/vocabulary/vocabulary.js index.html styles.css', { cwd: ROOT }).toString().trim().split('\n');
    const original = fs.readFileSync(path.join(ROOT, 'features/vocabulary/vocabulary.js'), 'utf8');
    if (!original.includes(V3_PATCH_FROM)) throw new Error('找不到 V4 的 band 計算片段，無法建立對照組');
    const control = original.replace(V3_PATCH_FROM, V3_PATCH_TO);

    const launchOpts = { headless: true };
    if (fs.existsSync(CHROME)) launchOpts.executablePath = CHROME;
    const browser = await chromium.launch(launchOpts);
    const results = [];

    for (const variant of [{ id: 'v3-control', body: control }, { id: 'v4-current', body: original }]) {
        for (const locale of ['zh-CN', 'zh-HK']) {
            const context = await browser.newContext({ viewport: { width: 320, height: 720 }, locale: locale === 'zh-HK' ? 'zh-HK' : 'zh-CN' });
            await context.route('**/*', (route) => {
                let url;
                try { url = new URL(route.request().url()); } catch (_) { return route.abort(); }
                if (url.pathname.endsWith('/ai-config.js')) return route.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK });
                if (url.pathname.endsWith('/features/vocabulary/vocabulary.js')) {
                    return route.fulfill({ status: 200, contentType: 'application/javascript', body: variant.body });
                }
                return (url.hostname === '127.0.0.1' || url.hostname === 'localhost') ? route.continue() : route.abort();
            });
            await context.addInitScript(({ locale }) => {
                localStorage.clear();
                localStorage.setItem('vocabularyBooks', '[]');
                localStorage.setItem('vocabImportPromptShown', '1');
                localStorage.setItem('pen_global_settings', JSON.stringify({ language: { interfaceLocale: locale }, assistant: { enabled: false } }));
            }, { locale });
            const page = await context.newPage();
            await page.goto(`${BASE}#v`, { waitUntil: 'load' });
            await page.waitForTimeout(1100);
            await page.click('#word-panel-more-btn');
            await page.waitForTimeout(280);
            const probe = await page.evaluate(PROBE);
            await page.screenshot({ path: path.join(SHOTS, `control-${variant.id}_${locale}-320x720-empty.png`) }).catch(() => {});
            results.push({ variant: variant.id, locale, ...probe });
            await context.close();
        }
    }

    await browser.close();
    const jsonPath = path.join(ASSET_DIR, 'menu-v3-control-v4.json');
    fs.writeFileSync(jsonPath, JSON.stringify({ finishedAt: new Date().toISOString(), build, results }, null, 2));
    results.forEach((r) => console.log(`${r.variant}/${r.locale}: menu=${r.menu.y}..${r.menu.bottom} maxH=${r.menu.maxHeight} navTop=${r.navTop} barBottom=${r.barBottom} lastItem=${r.lastItem.text}@${r.lastItem.centerY} hit=${r.lastItemHitTag} self=${r.lastItemHitSelf}`));
    console.log(`json: ${path.relative(ROOT, jsonPath)}`);
})();
