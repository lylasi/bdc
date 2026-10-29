/** 實際 UI 附加音訊、失敗重試、取消及獨立 file:// 閱讀版驗證。 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createReadingPanelFixture } = require('./helpers/reading-panel-fixture.cjs');

const DIALOG = '.reading-export-dialog';
const AUDIO = '#reading-export-audio-files';
const wave = Buffer.alloc(8044, 128);
wave.write('RIFF', 0);
wave.writeUInt32LE(wave.length - 8, 4);
wave.write('WAVEfmt ', 8);
wave.writeUInt32LE(16, 16);
wave.writeUInt16LE(1, 20);
wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(8000, 24);
wave.writeUInt32LE(8000, 28);
wave.writeUInt16LE(1, 32);
wave.writeUInt16LE(8, 34);
wave.write('data', 36);
wave.writeUInt32LE(wave.length - 44, 40);

const file = (name = 'My recording.wav', buffer = wave) => ({ name, mimeType: 'audio/wav', buffer });
const translate = (page, key) => page.evaluate(async key => (await import('/modules/i18n.js')).t(key), key);

async function openExport(page) {
    assert.equal(await page.locator('#article-reading-export-btn').getAttribute('title'), await translate(page, 'article.readingExportTitle'));
    await page.locator('#reading-export-md').click();
    await page.locator(DIALOG).waitFor();
}

async function expectError(page, key) {
    const expected = await translate(page, key);
    await page.waitForFunction(({ selector, expected }) => document.querySelector(`${selector} .reading-export-status`)?.textContent === expected, { selector: DIALOG, expected });
    assert.equal(await page.locator(`${DIALOG} #confirm-btn`).isDisabled(), false);
}

async function holdAudio(page) {
    await page.evaluate(() => {
        window.__audioNativeRead = FileReader.prototype.readAsArrayBuffer;
        window.__audioReads = [];
        window.__audioReadFinished = 0;
        FileReader.prototype.readAsArrayBuffer = function (file) {
            this.addEventListener('loadend', () => { window.__audioReadFinished += 1; });
            window.__audioReads.push(() => window.__audioNativeRead.call(this, file));
        };
    });
    await page.locator(`${DIALOG} #confirm-btn`).click();
    await page.waitForFunction(() => window.__audioReads.length === 1);
    assert.equal(await page.locator(`${DIALOG} #confirm-btn`).isDisabled(), true);
    assert.equal(await page.locator(AUDIO).isDisabled(), true);
}

async function releaseAudio(page) {
    await page.evaluate(() => {
        FileReader.prototype.readAsArrayBuffer = window.__audioNativeRead;
        window.__audioReads.forEach(read => read());
    });
    await page.waitForFunction(() => window.__audioReadFinished === 1);
    // FileReader 的事件先完成；下一輪事件處理才完成匯出 Promise 的取消檢查。
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
}

(async () => {
    const artifacts = process.env.ARTIFACT_DIR || await fs.mkdtemp(path.join(os.tmpdir(), 'bdc-reading-edition-'));
    await fs.mkdir(artifacts, { recursive: true });
    const browser = await chromium.launch({
        headless: true,
        executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        args: ['--autoplay-policy=no-user-gesture-required']
    });
    let checks = 0;
    const check = async (name, action) => {
        await action();
        checks += 1;
        console.log(`PASS ${name}`);
    };
    try {
        for (const locale of ['zh-CN', 'zh-HK']) {
            const { context, page, fixture, errors } = await createReadingPanelFixture(browser, { locale });
            const downloads = [];
            page.on('download', download => downloads.push(download));
            try {
                await check(`${locale}: audio limits, removal and format controls work without downloading`, async () => {
                    await openExport(page);
                    await page.locator(AUDIO).setInputFiles(Array.from({ length: 6 }, (_, index) => file(`part-${index}.wav`)));
                    const expected = await page.evaluate(async () => (await import('/modules/i18n.js')).t('article.exportAudioCountError', { count: 5 }));
                    assert.equal(await page.locator('.reading-export-status').textContent(), expected);
                    assert.equal(await page.locator('[data-audio-remove]').count(), 6);
                    await page.locator('[data-audio-remove]').last().click();
                    assert.equal(await page.locator('[data-audio-remove]').count(), 5);
                    await page.locator('.radio-group input[value="markdown"]').check();
                    assert.equal(await page.locator('.reading-export-audio').isVisible(), false);
                    assert.equal(await page.locator('input[data-option-key="fullText"]').isDisabled(), false);
                    await page.locator(`${DIALOG} #cancel-btn`).click();
                    assert.equal(downloads.length, 0);

                    await openExport(page);
                    await page.locator(AUDIO).setInputFiles(file('too-large.wav', Buffer.alloc(25 * 1024 * 1024 + 1)));
                    const tooLarge = await page.evaluate(async () => (await import('/modules/i18n.js')).t('article.exportAudioSizeError', { size: 25 }));
                    assert.equal(await page.locator('.reading-export-status').textContent(), tooLarge);
                    await page.locator(`${DIALOG} #cancel-btn`).click();
                });

                await check(`${locale}: invalid audio content is retained for correction and blocks the whole download`, async () => {
                    await openExport(page);
                    await page.locator(AUDIO).setInputFiles(file('pretend.wav', Buffer.from('invalid waveform')));
                    await page.locator(`${DIALOG} #confirm-btn`).click();
                    await expectError(page, 'article.exportAudioFormatError');
                    assert.equal(await page.locator('[data-audio-remove]').count(), 1);
                    assert.equal(downloads.length, 0);
                    await page.locator('[data-audio-remove]').click();
                    await page.locator(`${DIALOG} #cancel-btn`).click();
                });

                let htmlPath;
                await check(`${locale}: a failed audio read preserves the file and retries a real HTML download`, async () => {
                    // 立即匯出仍須 flush 尚未完成 debounce 的筆記草稿。
                    const expand = page.locator(`[data-item-id="${fixture.ids[0]}"] [data-action="expand"]`);
                    if (await expand.getAttribute('aria-expanded') !== 'true') await expand.click();
                    const note = page.locator(`[data-note-id="${fixture.ids[0]}"]`);
                    await note.fill(`UI_DRAFT_${locale}`);
                    await openExport(page);
                    await page.locator(AUDIO).setInputFiles(file('My recording <&>.wav'));
                    await page.evaluate(() => {
                        window.__audioNativeRead = FileReader.prototype.readAsArrayBuffer;
                        FileReader.prototype.readAsArrayBuffer = function () {
                            queueMicrotask(() => this.onerror?.(new Event('error')));
                        };
                    });
                    await page.locator(`${DIALOG} #confirm-btn`).click();
                    await expectError(page, 'article.exportAudioReadError');
                    assert.equal(await page.locator('[data-audio-remove]').count(), 1);
                    assert.equal(downloads.length, 0);
                    await page.evaluate(() => { FileReader.prototype.readAsArrayBuffer = window.__audioNativeRead; });
                    for (const width of [1440, 390]) {
                        await page.setViewportSize({ width, height: 844 });
                        await page.waitForTimeout(250);
                        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
                        const bounds = await page.locator(`${DIALOG} #confirm-btn`).boundingBox();
                        assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 844, `export action outside viewport: ${JSON.stringify(bounds)}`);
                        await page.screenshot({ path: path.join(artifacts, `${locale}-export-dialog-${width}.png`) });
                    }
                    const downloading = page.waitForEvent('download');
                    await page.locator(`${DIALOG} #confirm-btn`).click();
                    const download = await downloading;
                    assert.match(download.suggestedFilename(), /\.html$/);
                    htmlPath = path.join(artifacts, `${locale}-reading-edition.html`);
                    await download.saveAs(htmlPath);
                    await page.locator(DIALOG).waitFor({ state: 'detached' });
                    assert.equal(downloads.length, 1);
                    const html = await fs.readFile(htmlPath, 'utf8');
                    assert.ok(html.includes(`UI_DRAFT_${locale}`));
                    assert.ok(html.includes('data:audio/wav;base64,'));
                });

                await check(`${locale}: downloaded file opens independently, navigates marks and plays embedded audio offline`, async () => {
                    const offline = await browser.newContext({ javaScriptEnabled: false });
                    try {
                        const requests = [];
                        await offline.route(/^https?:/, route => { requests.push(route.request().url()); return route.abort(); });
                        const reader = await offline.newPage();
                        await reader.goto(pathToFileURL(htmlPath).href);
                        assert.equal(await reader.locator('html').getAttribute('lang'), locale);
                        assert.equal(await reader.locator('.learning-card').count(), fixture.ids.length);
                        assert.equal(await reader.locator('script, img, iframe, link[rel="stylesheet"]').count(), 0);
                        assert.equal(await reader.locator('audio').count(), 1);
                        const target = await reader.locator('.text-mark').first().getAttribute('href');
                        await reader.locator('.text-mark').first().click();
                        assert.equal(new URL(reader.url()).hash, target);
                        await reader.locator(`${target} .back-to-text`).click();
                        assert.match(new URL(reader.url()).hash, /^#original-item-/);
                        const playback = await reader.locator('audio').evaluate(async audio => {
                            audio.load();
                            await audio.play();
                            return { duration: audio.duration, paused: audio.paused, error: audio.error?.code || null };
                        });
                        assert.equal(playback.duration, 1);
                        assert.equal(playback.paused, false);
                        assert.equal(playback.error, null);
                        // 文件停用 JavaScript，不能依賴文件內的 timer／timeupdate 回呼。
                        await reader.waitForTimeout(200);
                        assert.ok(await reader.locator('audio').evaluate(audio => audio.currentTime > 0));
                        await reader.locator('audio').evaluate(audio => audio.pause());
                        for (const width of [1440, 390]) {
                            await reader.setViewportSize({ width, height: 844 });
                            await reader.goto(pathToFileURL(htmlPath).href);
                            await reader.waitForTimeout(100);
                            assert.equal(await reader.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
                            await reader.screenshot({ path: path.join(artifacts, `${locale}-reading-edition-${width}.png`) });
                        }
                        assert.deepEqual(requests, []);
                    } finally { await offline.close(); }
                });

                await check(`${locale}: cancelling during file reading allows no stale download`, async () => {
                    await openExport(page);
                    await page.locator(AUDIO).setInputFiles(file());
                    await holdAudio(page);
                    await page.locator(`${DIALOG} #cancel-btn`).click();
                    await releaseAudio(page);
                    assert.equal(await page.locator(DIALOG).count(), 0);
                    assert.equal(downloads.length, 1);
                });

                await check(`${locale}: changing article during file reading cancels the pending export`, async () => {
                    await openExport(page);
                    await page.locator(AUDIO).setInputFiles(file());
                    await holdAudio(page);
                    await page.evaluate(async () => {
                        const art = await import('/modules/article-store.js');
                        const state = await import('/modules/state.js');
                        const id = 'other-export-article';
                        await art.saveArticle({ articleId: id, article: 'Other private article.', title: 'Other private article', result: { chinese_translation: '另一篇文章。' } });
                        state.setCurrentArticleId(id);
                        await (await import('/features/article/article.js')).showCurrentArticleIfAvailable();
                    });
                    await releaseAudio(page);
                    assert.equal(await page.locator(DIALOG).count(), 0);
                    assert.equal(downloads.length, 1);
                    await page.evaluate(async id => {
                        (await import('/modules/state.js')).setCurrentArticleId(id);
                        await (await import('/features/article/article.js')).showCurrentArticleIfAvailable();
                    }, fixture.articleId);
                    await page.locator('.reading-item').first().waitFor();
                });

                await check(`${locale}: changing language during file reading cancels the pending export`, async () => {
                    await openExport(page);
                    await page.locator(AUDIO).setInputFiles(file());
                    await holdAudio(page);
                    await page.evaluate(async locale => (await import('/modules/i18n.js')).setLocale(locale === 'zh-CN' ? 'zh-HK' : 'zh-CN', { persist: false }), locale);
                    await releaseAudio(page);
                    assert.equal(await page.locator(DIALOG).count(), 0);
                    assert.equal(downloads.length, 1);
                    await page.evaluate(async locale => (await import('/modules/i18n.js')).setLocale(locale, { persist: false }), locale);
                    await page.locator('.reading-item').first().waitFor();
                });

                await check(`${locale}: changing account during file reading allows no stale download`, async () => {
                    await openExport(page);
                    await page.locator(AUDIO).setInputFiles(file());
                    await holdAudio(page);
                    await page.evaluate(async () => {
                        await (await import('/modules/article-store.js')).reloadScope('reading-edition-ui::other-user');
                        await (await import('/modules/reading-store.js')).reloadReadingScope('reading-edition-ui::other-user');
                        document.dispatchEvent(new CustomEvent('bdc:articles-scope-changed'));
                    });
                    await releaseAudio(page);
                    assert.equal(await page.locator(DIALOG).count(), 0);
                    assert.equal(downloads.length, 1);
                    assert.deepEqual(errors, []);
                });
            } finally { await context.close(); }
        }
        console.log(`${checks} UI/offline checks passed. Artifacts: ${artifacts}`);
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
