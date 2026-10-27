/**
 * 文章側欄收合、正文擴闊與共用朗讀控制回歸。
 * 先啟動 scripts/serve.py，再執行：
 * PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/article-reading-layout.cjs
 * 可用 ARTIFACT_DIR 指定截圖目錄；語音、AI 及同步均使用隔離 mock。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const mock = require('./helpers/article-mock.cjs');

const BASE = `http://127.0.0.1:${process.env.PORT || 8313}/`;
const PARAGRAPHS = [
    'Mike: Some volunteers help sell flags in the street. There are some other volunteers who help online. I am one of them. Last month, I filmed a video to encourage people to donate money and posted it online. Although it took time, it was meaningful.',
    'Anna: We watched your video! It has inspired us to do voluntary work. Next month, I am going to visit an elderly home and make crafts with the elderly. Some elderly people may feel bored. I hope spending time with them will bring them joy.',
    ...Array.from({ length: 10 }, (_, i) => `Chapter ${i + 1}: Reading together helps us understand the world. We share stories and learn something new every day.`)
];
const BODY = PARAGRAPHS.join('\n\n');
const DOC = {
    id: 'art_reading_layout', title: 'Voluntary work', body: BODY, sourceType: 'paste', revision: 0,
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    lastOpenedAt: '2026-10-01T00:00:00.000Z',
    analysis: {
        chinese_translation: '义工服务。', word_alignment: [], detailed_analysis: [],
        sentence_analysis: [], phrase_analysis: [],
        paragraph_analysis: PARAGRAPHS.map((_, i) => ({
            chinese_translation: i === 0 ? '一些义工在街上帮忙卖旗，另一些则在网上提供帮助。虽然花了时间，但很有意义。'
                : i === 1 ? '我们看了你的视频！它启发我们参加义工服务。我希望与长者共度的时光能为他们带来快乐。'
                    : '一起阅读帮助我们了解世界。我们分享故事，每天学习新知识。',
            word_alignment: [], detailed_analysis: []
        }))
    }
};
let checks = 0;
function check(name, condition, detail) {
    assert.ok(condition, `${name}: ${JSON.stringify(detail)}`);
    checks += 1;
    console.log(`PASS ${name}`);
}
const translated = (page, key) => page.evaluate(async (k) => (await import('/modules/i18n.js')).t(k), key);
const setLocale = (page, locale) => page.evaluate(async (value) => (await import('/modules/i18n.js')).setLocale(value), locale);
const speechCount = (page) => page.evaluate(() => window.__speech.length);
async function clickReaderAction(page, id) {
    const button = page.locator('#' + id);
    if (!await button.isVisible()) await page.locator('#article-reader-more-toggle').click();
    await button.click();
}
const toggle = (page) => clickReaderAction(page, 'article-sidebar-toggle');

async function expectPlayback(page, key, stopped = false) {
    const label = await translated(page, key);
    await page.waitForFunction(({ label, stopped }) => ['read-article-btn', 'article-compact-read-btn'].every((id) => (
        document.getElementById(id).getAttribute('aria-label') === label
    )) && ['stop-read-article-btn', 'article-compact-stop-btn'].every((id) => (
        document.getElementById(id).disabled === stopped
    )), { label, stopped });
    check(`兩組朗讀控制同步：${key}`, true);
}

async function openArticle(page) {
    await mock.seedDocs(page, [DOC]);
    await page.evaluate(async () => { await (await import('/modules/article-store.js')).reloadScope(); });
    await page.locator('#article-history-btn').click();
    await page.locator(`.ar-history-item[data-key="${DOC.id}"] .ar-history-open`).click();
    await page.waitForSelector('.paragraph-pair[data-paragraph-index="11"]');
    await page.evaluate(() => { window.__firstReadingParagraph = document.querySelector('.paragraph-pair'); });
}

async function screenshot(page, name) {
    if (!process.env.ARTIFACT_DIR) return;
    fs.mkdirSync(process.env.ARTIFACT_DIR, { recursive: true });
    await page.screenshot({
        path: path.join(process.env.ARTIFACT_DIR, name + '.png'),
        style: '#message-container { visibility: hidden !important; }'
    });
}

async function runLocale(browser, locale) {
    console.log(`\n[${locale}]`);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await mock.initScript(context, { locale });
    await context.addInitScript(() => {
        const settings = JSON.parse(localStorage.getItem('pen_global_settings') || '{}');
        settings.tts = { use: 'custom', baseUrlCustom: 'https://example.com' };
        settings.reading = { translationMask: false, englishVariant: 'en-US', ...settings.reading };
        localStorage.setItem('pen_global_settings', JSON.stringify(settings));
        window.__speech = [];
        Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
            getVoices: () => [], cancel: () => {}, pause: () => {}, resume: () => {},
            speak: (utterance) => { window.__speech.push(utterance); utterance.onstart?.(); }
        } });
        window.SpeechSynthesisUtterance = function (text) { this.text = String(text || ''); };
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await mock.installProviderRoutes(page, ({ route, prompt }) => mock.jsonReply(route, mock.translatedParagraphReply(prompt)));
    await page.route(mock.ENDPOINT + '/**', (route) => route.fulfill({ status: 401, body: '{}' }));
    try {
        await page.goto(BASE + '#a', { waitUntil: 'load' });
        await page.locator('#article-sidebar-toggle').waitFor();
        await page.evaluate(() => document.querySelector('#app-modal:not(.hidden) .modal-close-btn')?.click());
        await openArticle(page);
        check('預設保留側欄', await page.locator('#article-sidebar').isVisible());
        const originalWidth = (await page.locator('.analysis-result').boundingBox()).width;
        await page.locator('.speed-btn[data-speed="50"]').click();
        await screenshot(page, locale + '-expanded');
        await toggle(page);
        const expandedWidth = (await page.locator('.analysis-result').boundingBox()).width;
        check('收起側欄後正文擴闊', expandedWidth > originalWidth + 300, { originalWidth, expandedWidth });
        check('收起後保留播放控制及目前語速', await page.locator('#article-compact-controls').isVisible()
            && await page.locator('#article-compact-speed').inputValue() === '50'
            && await page.locator('#article-compact-speed-value').innerText() === 'x1.25'
            && !await page.locator('#article-compact-speed-panel').isVisible());
        check('收合按鈕提供可存取狀態', await page.locator('#article-sidebar-toggle').getAttribute('aria-expanded') === 'false'
            && !await page.locator('#article-sidebar').isVisible());
        const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('pen_global_settings')).reading);
        check('即時記住收合且保留其他閱讀設定', saved.articleSidebarCollapsed === true
            && saved.translationMask === false && saved.englishVariant === 'en-US', saved);
        await screenshot(page, locale + '-collapsed');

        check('輸入、導入、文章庫及閱讀記錄集中於頂欄', await page.evaluate(() => (
            ['article-input-toggle', 'import-article-btn', 'show-article-library-btn', 'article-history-btn']
                .every((id) => document.getElementById('article-reader-head').contains(document.getElementById(id)))
        )));
        check('收起時輸入框按需顯示', !await page.locator('#article-input-editor').isVisible());
        await page.locator('#article-input-toggle').click();
        check('頂欄輸入可直接編輯且保留原文', await page.locator('#article-input').inputValue() === BODY
            && await page.locator('#article-input').evaluate((el) => el === document.activeElement)
            && await page.locator('#article-input-toggle').getAttribute('aria-expanded') === 'true'
            && await page.locator('#article-input-close').getAttribute('aria-label') === await translated(page, 'article.closeInput'));
        await screenshot(page, locale + '-input');
        await page.locator('#article-input').fill(BODY + '\n\nAn edited draft.');
        await setLocale(page, locale === 'zh-CN' ? 'zh-HK' : 'zh-CN');
        check('切換語言保留輸入面板和編輯內容', await page.locator('#article-input-editor').isVisible()
            && (await page.locator('#article-input').inputValue()).endsWith('An edited draft.')
            && await page.locator('#article-input-toggle').getAttribute('aria-label') === await translated(page, 'article.inputTitle'));
        await setLocale(page, locale);
        await page.keyboard.press('Escape');
        check('Escape 收起輸入並還原焦點', !await page.locator('#article-input-editor').isVisible()
            && await page.locator('#article-input-toggle').evaluate((el) => el === document.activeElement));
        await page.locator('#article-input-toggle').click();
        await page.locator('#article-input').fill(BODY);
        await page.locator('#article-input-toggle').click();
        check('輸入按鈕可再次收起而不展開側欄', !await page.locator('#article-input-editor').isVisible()
            && !await page.locator('#article-sidebar').isVisible());
        await page.locator('#article-input-toggle').click();
        await page.locator('#import-article-btn').focus();
        await page.keyboard.press('Enter');
        await page.locator('#app-modal .import-tabbar').waitFor();
        check('頂欄導入沿用原有導入流程並收起輸入', await page.locator('#app-modal').isVisible()
            && !await page.locator('#article-input-editor').isVisible());
        await page.locator('#app-modal .modal-close-btn').click();
        await page.locator('#show-article-library-btn').click();
        await page.locator('#article-library-modal .article-library-item').first().waitFor();
        check('收起側欄仍可選取文章庫', await page.locator('#article-library-modal').isVisible());
        await page.locator('#article-library-modal .modal-close-btn').click();
        await page.locator('#article-history-btn').click();
        await page.locator(`.ar-history-item[data-key="${DOC.id}"]`).waitFor();
        check('收起側欄仍可開啟閱讀記錄', await page.locator('#app-modal').isVisible()
            && !await page.locator('#article-sidebar').isVisible());
        await page.locator('#app-modal .modal-close-btn').click();

        await page.locator('#article-compact-speed-toggle').click();
        check('點擊倍速展開滑軌', await page.locator('#article-compact-speed-panel').isVisible()
            && await page.locator('#article-compact-speed-toggle').getAttribute('aria-expanded') === 'true'
            && await page.locator('#article-compact-speed-toggle').getAttribute('title') === await translated(page, 'article.adjustSpeed'));
        await page.locator('#article-compact-speed-panel > span').first().click();
        check('點擊面板標籤不會誤收起', await page.locator('#article-compact-speed-panel').isVisible());
        const panelBox = await page.locator('#article-compact-speed-panel').boundingBox();
        await page.mouse.click(panelBox.x + 3, panelBox.y + panelBox.height / 2);
        check('點擊面板留白不會誤收起', await page.locator('#article-compact-speed-panel').isVisible());
        await page.locator('#article-compact-speed').press('End');
        check('精簡語速同步回側欄', await page.locator('.speed-btn.active').getAttribute('data-speed') === '100'
            && await page.locator('#article-compact-speed-value').innerText() === 'x1.5'
            && await page.locator('#article-compact-speed').getAttribute('aria-valuetext') === 'x1.5');
        const slider = await page.locator('#article-compact-speed').boundingBox();
        await page.mouse.click(slider.x + slider.width / 2, slider.y + slider.height / 2);
        check('點擊軌道可調速且保持展開', await page.locator('#article-compact-speed-panel').isVisible()
            && await page.locator('#article-compact-speed-value').innerText() === 'x1.0');
        const dragSpeed = async (from, to) => {
            await page.mouse.move(slider.x + slider.width / 2, from);
            await page.mouse.down();
            await page.mouse.move(slider.x + slider.width / 2, to, { steps: 6 });
            await page.mouse.up();
        };
        await dragSpeed(slider.y + 8, slider.y + slider.height - 8);
        check('向下拖動減速至最低檔', await page.locator('.speed-btn.active').getAttribute('data-speed') === '-100'
            && await page.locator('#article-compact-speed-value').innerText() === 'x0.5');
        await dragSpeed(slider.y + slider.height - 8, slider.y + 8);
        check('向上拖動加速至最高檔', await page.locator('#article-compact-speed-value').innerText() === 'x1.5');
        await page.mouse.move(slider.x + slider.width / 2, slider.y + 8);
        await page.mouse.down();
        await page.mouse.move(slider.x - 100, slider.y + slider.height - 8, { steps: 6 });
        await page.mouse.up();
        check('拖出面板放開不會誤收起', await page.locator('#article-compact-speed-panel').isVisible());
        await page.locator('#article-compact-speed').press('End');
        await page.keyboard.press('Escape');
        check('Escape 收起滑軌並還原焦點', !await page.locator('#article-compact-speed-panel').isVisible()
            && await page.locator('#article-compact-speed-toggle').getAttribute('aria-expanded') === 'false'
            && await page.locator('#article-compact-speed-toggle').evaluate((el) => el === document.activeElement));
        await page.locator('#article-compact-speed-toggle').click();
        await page.locator('#article-reader-head').click({ position: { x: 3, y: 3 } });
        check('點擊外部收起滑軌且保留倍速', !await page.locator('#article-compact-speed-panel').isVisible()
            && await page.locator('#article-compact-speed-value').innerText() === 'x1.5');
        await page.locator('#article-compact-speed-toggle').focus();
        await page.locator('#article-compact-speed-toggle').press('Enter');
        check('鍵盤開啟後聚焦滑軌', await page.locator('#article-compact-speed-panel').isVisible()
            && await page.locator('#article-compact-speed').evaluate((el) => el === document.activeElement));
        await page.keyboard.press('Escape');
        await page.locator('#article-compact-read-btn').click();
        await expectPlayback(page, 'article.pause');
        const started = await speechCount(page);
        await toggle(page);
        check('展開側欄不中斷或重播語音', await speechCount(page) === started);
        await page.locator('#read-article-btn').click();
        await expectPlayback(page, 'article.resume');
        await toggle(page);
        await setLocale(page, locale === 'zh-CN' ? 'zh-HK' : 'zh-CN');
        await expectPlayback(page, 'article.resume');
        check('語言切換保留收合及按鈕文案', await page.locator('#article-sidebar-toggle').getAttribute('aria-label')
            === await translated(page, 'article.expandSidebar'));
        await page.locator('#article-compact-read-btn').click();
        await expectPlayback(page, 'article.pause');
        check('精簡播放鈕恢復朗讀', await speechCount(page) > started);
        await page.evaluate(() => document.dispatchEvent(new CustomEvent('bdc:audio-interrupted', {
            detail: { owner: 'article-reading', by: 'word-pronunciation' }
        })));
        await expectPlayback(page, 'article.replayChunk');
        await page.locator('#article-compact-read-btn').click();
        await expectPlayback(page, 'article.pause');
        await page.locator('#article-compact-stop-btn').click();
        await expectPlayback(page, 'article.read', true);
        check('停止後精簡控制仍可操作', await page.locator('#article-compact-controls').isVisible());
        await setLocale(page, locale);

        // 模擬自然播放完成及音訊失敗，確認兩組控制都能回到可重新播放狀態。
        await page.locator('#article-compact-read-btn').click();
        await page.evaluate(() => {
            for (let i = 0; i < 100 && !document.getElementById('article-compact-stop-btn').disabled; i += 1) {
                window.__speech.at(-1).onend?.();
            }
        });
        await expectPlayback(page, 'article.read', true);
        await page.locator('#article-compact-read-btn').click();
        await page.evaluate(() => window.__speech.at(-1).onerror?.({ error: 'mock-speech-failure' }));
        await expectPlayback(page, 'article.read', true);
        check('音訊失敗提示已翻譯', (await page.locator('#message-container').innerText()).includes(await translated(page, 'article.audioFailed')));
        await toggle(page);
        await page.locator('#article-input').fill('');
        await toggle(page);
        const beforeEmpty = await speechCount(page);
        await page.locator('#article-compact-read-btn').click();
        check('空文章播放提示已翻譯', await speechCount(page) === beforeEmpty
            && (await page.locator('#message-container').innerText()).includes(await translated(page, 'article.enterArticleToRead')));
        await toggle(page);
        await page.locator('#article-input').fill(BODY);
        await toggle(page);
        check('收合與語言切換保留原文和分析 DOM', await page.evaluate((body) => (
            document.getElementById('article-input').value === body && window.__firstReadingParagraph.isConnected
        ), BODY));

        // 新增的工具列在手機、平板、桌面及放大文字後仍須可點，並避開既有導航。
        for (const [width, height, zoom] of [[320, 667, false], [360, 800, false], [375, 667, false], [390, 844, false], [430, 932, false], [768, 1024, false],
            [900, 900, false], [1024, 768, false], [375, 667, true], [1440, 900, false]]) {
            await page.setViewportSize({ width, height });
            await page.evaluate((zoom) => { document.documentElement.style.fontSize = zoom ? '32px' : ''; }, zoom);
            await page.evaluate(() => window.scrollTo(0, 700));
            await page.waitForTimeout(300);
            const layout = await page.evaluate(() => {
                const head = document.querySelector('.article-reader-head').getBoundingClientRect();
                const nav = document.querySelector('.app-nav');
                const navBottom = innerWidth >= 768 && innerWidth < 1024 ? nav.getBoundingClientRect().bottom : 0;
                const top = Math.max(navBottom, document.querySelector('.app-bar').getBoundingClientRect().bottom);
                const controls = ['article-sidebar-toggle', 'article-compact-read-btn', 'article-compact-stop-btn', 'article-compact-speed-toggle',
                    'article-input-toggle', 'import-article-btn', 'show-article-library-btn', 'article-history-btn', 'article-reader-more-toggle'];
                const menu = document.getElementById('article-reader-menu');
                return { head: head.toJSON(), top, viewport: innerWidth, noOverflow: document.documentElement.scrollWidth <= innerWidth, controls: controls.map((id) => {
                    const el = document.getElementById(id);
                    const rect = el.getBoundingClientRect();
                    if (!rect.width) return id === 'article-reader-more-toggle' || menu.contains(el);
                    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
                    return rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight && el.contains(hit)
                        && Math.abs(rect.y + rect.height / 2 - head.y - head.height / 2) < 1;
                }) };
            });
            check(`${width}×${height}${zoom ? ' 200% 文字' : ''}：控制單行黏頂且不被遮擋`, layout.head.top >= layout.top
                && layout.head.top < layout.top + 40 && layout.controls.every(Boolean) && layout.noOverflow, layout);
            if (await page.locator('#article-reader-more-toggle').isVisible()) {
                await page.locator('#article-reader-more-toggle').focus();
                await page.keyboard.press('Enter');
                check(`${width}：更多選單可用鍵盤展開並聚焦操作`, await page.locator('#article-reader-menu').isVisible()
                    && await page.locator('#article-reader-menu').evaluate((el) => el.contains(document.activeElement)));
                const menu = await page.locator('#article-reader-menu').boundingBox();
                check(`${width}：收納操作完整顯示且不超出視窗`, menu.x >= 0 && menu.x + menu.width <= width
                    && await page.locator('#article-reader-menu > button').evaluateAll((buttons) => buttons.every((button) => {
                        const label = button.querySelector('.article-action-label');
                        return button.offsetHeight >= 44 && label && label.getBoundingClientRect().width > 5;
                    })), menu);
                if (!zoom && width === 390) await screenshot(page, `${locale}-390-more`);
                await page.keyboard.press('Escape');
                check(`${width}：Escape 收起更多並還原焦點`, !await page.locator('#article-reader-menu').isVisible()
                    && await page.locator('#article-reader-more-toggle').evaluate((el) => el === document.activeElement));
                await page.locator('#article-reader-more-toggle').click();
                await page.locator('#article-compact-read-btn').focus();
                check(`${width}：離開選單時收起更多`, !await page.locator('#article-reader-menu').isVisible());
            }
            if (!zoom && (width === 390 || width === 900)) await screenshot(page, `${locale}-${width}-sticky`);
            await page.locator('#article-compact-speed-toggle').click();
            const speedPanel = await page.locator('#article-compact-speed-panel').boundingBox();
            const speedSlider = await page.locator('#article-compact-speed').boundingBox();
            check(`${width}×${height}${zoom ? ' 200% 文字' : ''}：竪向語速面板不超出視窗`, speedPanel.x >= 0
                && speedPanel.x + speedPanel.width <= width && speedPanel.y + speedPanel.height < height
                && speedSlider.height > speedSlider.width, { speedPanel, speedSlider });
            if (!zoom && (width === 390 || width === 900)) await screenshot(page, `${locale}-${width}-speed`);
            await page.keyboard.press('Escape');
            await clickReaderAction(page, 'article-input-toggle');
            const editor = await page.locator('#article-input-editor').boundingBox();
            check(`${width}×${height}${zoom ? ' 200% 文字' : ''}：輸入面板不超出視窗`, editor.x >= 0
                && editor.x + editor.width <= width && editor.y + editor.height < height, editor);
            if (!zoom && width === 390) await screenshot(page, `${locale}-390-input`);
            await page.locator('#article-input-close').click();
        }
        check('桌面有足夠空間時所有操作自動回到工具列', !await page.locator('#article-reader-more-toggle').isVisible()
            && await page.locator('#article-reader-menu > button').count() === 0);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.locator('#article-reading-records-btn').click();
        check('開啟學習記錄時正文仍填滿可用欄位', await page.evaluate(() => {
            const grid = document.querySelector('#article-section .analysis-container');
            return Math.abs(grid.getBoundingClientRect().width - grid.querySelector('.analysis-result').getBoundingClientRect().width) < 2;
        }));
        await page.locator('#article-reading-panel .reading-panel-close').click();

        await page.locator('#article-input-toggle').click();
        await page.locator('#clear-article-btn').click();
        check('頂部輸入保留清除操作', await page.locator('#article-input').inputValue() === '');
        const newBody = 'A compact editor keeps the article within reach.';
        await page.locator('#article-input').fill(newBody);
        await page.locator('#analyze-article-btn').click();
        await page.waitForFunction((text) => document.querySelector('.paragraph-english')?.textContent.includes(text), newBody);
        check('頂部輸入可直接分析新文章', (await page.locator('.paragraph-english').first().innerText()).includes(newBody)
            && !await page.locator('#article-sidebar').isVisible());
        await page.locator('#article-input-close').click();

        // 真實 audio 元素等待遠端回應時，loading 狀態也需正確翻譯且可停止。
        await page.route('https://tts.mock/**', () => {});
        await page.evaluate(async () => (await import('/modules/settings.js')).saveGlobalSettings({
            tts: { use: 'custom', baseUrlCustom: 'https://tts.mock' }
        }));
        await page.locator('#article-compact-read-btn').click();
        await expectPlayback(page, 'article.loading');
        await setLocale(page, locale === 'zh-CN' ? 'zh-HK' : 'zh-CN');
        await expectPlayback(page, 'article.loading');
        await page.locator('#article-compact-stop-btn').click();
        await expectPlayback(page, 'article.read', true);
        await page.reload({ waitUntil: 'load' });
        await page.locator('#article-compact-controls').waitFor();
        check('重新載入後保留收合狀態', !await page.locator('#article-sidebar').isVisible()
            && await page.locator('#article-sidebar-toggle').getAttribute('aria-expanded') === 'false');
        check('沒有 JavaScript 例外', errors.length === 0, errors);
    } finally {
        await context.close();
    }
}

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: mock.CHROME });
    try {
        for (const locale of ['zh-CN', 'zh-HK']) await runLocale(browser, locale);
        console.log(`\n${checks} checks passed`);
    } finally {
        await browser.close();
    }
})().catch((error) => { console.error(error); process.exitCode = 1; });
