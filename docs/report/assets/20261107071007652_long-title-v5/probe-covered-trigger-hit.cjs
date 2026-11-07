#!/usr/bin/env node
/**
 * V5 補充量測（不計入案例數）：
 * 針對「按鈕與操作帶交集＝0」的 8 個組合（320/360 寬 × 500/520 高 × 2 語言、空詞書），
 * 在被測程式未點擊前，用 elementFromPoint 檢查 ⋯ 按鈕中心點是否真的被人類可點到；
 * 用來支撐「完全被底部導覽列蓋住時，收合才是正確結果」的判定。
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${PORT}/`;
const ASSET_DIR = __dirname;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const MOCK = `export const AI_LIMITS={default:{maxConcurrency:1,minIntervalMs:400}};
export const TTS_CONFIG={baseUrl:'',baseUrlRemote:'',baseUrlLocal:'',use:'remote',voicesUrl:'',apiKey:'',voices:{}};
export const OCR_CONFIG={DEFAULT_MODEL:''};
export const ARTICLE_IMPORT={FEED_URL:'',PROXY_URL:'',SOURCES:[]};
export const SYNC={};export const SUPABASE={};`;

const HIT = () => {
    const more = document.getElementById('word-panel-more-btn');
    const nav = document.querySelector('.app-nav');
    const bar = document.querySelector('.app-bar');
    const r = more.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    const label = (el) => (el ? `${el.tagName}#${el.id || ''}.${String(el.className || '').slice(0, 24)}` : '(null: 視窗外或不可命中)');
    const nr = nav.getBoundingClientRect();
    const br = bar.getBoundingClientRect();
    const overlap = Math.max(0, Math.min(r.bottom, nr.bottom) - Math.max(r.top, nr.top));
    return {
        trigger: { top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1), height: +r.height.toFixed(1), centerY: +cy.toFixed(1) },
        band: { top: +br.bottom.toFixed(1), bottom: +nr.top.toFixed(1) },
        navRect: { top: +nr.top.toFixed(1), bottom: +nr.bottom.toFixed(1) },
        triggerCoveredByNavPx: +overlap.toFixed(1),
        triggerVisiblePx: +Math.max(0, Math.min(r.bottom, nr.top) - Math.max(r.top, br.bottom)).toFixed(1),
        hitTarget: label(hit),
        hitIsTrigger: !!hit && (hit === more || more.contains(hit))
    };
};

(async () => {
    const launchOpts = { headless: true };
    if (fs.existsSync(CHROME)) launchOpts.executablePath = CHROME;
    const browser = await chromium.launch(launchOpts);
    const rows = [];
    for (const locale of ['zh-CN', 'zh-HK']) {
        for (const width of [320, 360]) {
            for (const height of [500, 520]) {
                const context = await browser.newContext({ viewport: { width, height }, locale });
                await context.route('**/*', (route) => {
                    let url;
                    try { url = new URL(route.request().url()); } catch (_) { return route.abort(); }
                    if (url.pathname.endsWith('/ai-config.js')) return route.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK });
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
                await page.evaluate(() => window.scrollTo(0, 0));
                await page.waitForTimeout(150);
                const hit = await page.evaluate(HIT);
                rows.push({ locale, size: `${width}x${height}`, ...hit });
                await context.close();
            }
        }
    }
    await browser.close();
    fs.writeFileSync(path.join(ASSET_DIR, 'covered-trigger-hit.json'), JSON.stringify({ measuredAt: new Date().toISOString(), rows }, null, 2));
    console.log('locale size    trigger(top..bottom) 帶(top..bottom) 被底欄蓋住 可見區 按鈕中心命中元素');
    rows.forEach((r) => {
        console.log(`${r.locale} ${r.size} ${String(r.trigger.top).padStart(7)}..${String(r.trigger.bottom).padEnd(7)} ${String(r.band.top).padStart(4)}..${String(r.band.bottom).padEnd(5)} ${String(r.triggerCoveredByNavPx).padStart(6)}px ${String(r.triggerVisiblePx).padStart(5)}px ${r.hitIsTrigger ? '按鈕本身' : r.hitTarget}`);
    });
    console.log(`\n完全不可點(=收合為正確結果)的比例: ${rows.filter((r) => !r.hitIsTrigger).length}/${rows.length}`);
})();
