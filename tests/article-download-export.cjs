/**
 * 文章詳解 Phase 2 第二批 B：P2-T6（播放／下載能力分離、下載範圍）＋
 * P2-T7（匯出範圍摘要、雙入口統一）驗收。
 *
 * 覆蓋：
 *   - 無遠端 TTS：播放仍走本機語音；按下載只給提示，不開新分頁、不請求 TTS
 *   - 全文 10k 字：下載被阻擋並提示改用段落／句子；句子模式可進確認框
 *   - 確認框顯示範圍與 host；取消不開連結
 *   - 確認後只提示「已開啟下載連結」，不是「下載完成」，且不洩漏 api_key
 *   - 兩個匯出入口（頂部、面板）開同一個範圍對話框，顯示標題／數量／版本
 *   - 預設完整 HTML（含全文與已保存對話），Markdown 明確選取後仍支援 note-only
 *   - 真實 HTML 下載在雙語下包含正確標題／本機範圍／筆記／對話，且排除其他文章
 *   - 匯出失敗保留對話框與選擇供重試，成功後關閉
 *   - 獨立 JSON 備份入口沒有閱讀格式選項，仍含目前 scope 的文章與閱讀資料
 *   - 無文章不開空對話框
 *   - zh-CN／zh-HK 動態文案
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/article-download-export.cjs
 *
 * 不連真實 AI／TTS／同步端點；TTS 由 route mock 回應。
 */
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const mock = require('./helpers/article-mock.cjs');
const { exportReadingNote } = require('./helpers/reading-export.cjs');

const EXPORT_DIALOG = '.options-modal-overlay.reading-export-dialog';
const PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${PORT}/`;
const TTS_HOST = 'https://tts.mock';
const TTS_KEY = 'tts-secret-key-should-not-leak';

const { check, finish } = mock.createReporter('文章下載能力與匯出範圍（P2-T6／P2-T7）');

const TTS_NOOP = `
    window.__spoken = [];
    try {
        Object.defineProperty(window, 'speechSynthesis', {
            configurable: true,
            value: {
                getVoices: () => [],
                cancel: () => {},
                pause: () => {},
                resume: () => {},
                speak: (utterance) => {
                    window.__spoken.push(String(utterance && utterance.text || ''));
                    try { if (utterance && utterance.onstart) utterance.onstart(); } catch (_) {}
                }
            }
        });
    } catch (_) {}
    try {
        window.SpeechSynthesisUtterance = function (text) { this.text = String(text || ''); };
    } catch (_) {}
`;

const LONG_SENTENCE = 'The archive keeps a quiet record of every reader who visits the reading room. ';
const LONG_TEXT = LONG_SENTENCE.repeat(140); // 約 11.5k 字元

const EXPORT_BODY = 'The reading room opens at eight. EXPORT_ARTICLE_BODY_MARKER visitors sign the book at the door.';
const OTHER_BODY = 'Another reading room contains OTHER_ARTICLE_BODY_MARKER.';
const EXPORT_ANALYSIS = {
    chinese_translation: '阅览室八点开门。访客在门口签到。',
    word_alignment: [],
    detailed_analysis: [],
    paragraph_analysis: [{ chinese_translation: '阅览室八点开门。访客在门口签到。', word_alignment: [], detailed_analysis: [] }],
    sentence_analysis: [],
    phrase_analysis: []
};

function recordDoc(id, title, body, analysis) {
    return {
        id,
        title,
        body,
        analysis,
        sourceType: 'paste',
        revision: 0,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        lastOpenedAt: '2026-10-18T08:00:00.000Z'
    };
}

async function makePage(browser, { locale = 'zh-CN', tts = 'configured', viewport = { width: 1280, height: 900 } } = {}) {
    const context = await browser.newContext({ viewport, acceptDownloads: true });
    await mock.initScript(context, { locale });
    await context.addInitScript(TTS_NOOP);

    const ttsConfig = tts === 'configured'
        ? `export const TTS_CONFIG = ${JSON.stringify({
            baseUrl: TTS_HOST,
            baseUrlRemote: TTS_HOST,
            use: 'remote',
            apiKey: TTS_KEY,
            voices: {
                english: 'en-US-JennyNeural',
                chinese: 'zh-CN-XiaoxiaoNeural',
                cantonese: 'zh-HK-HiuGaaiNeural'
            }
        })};`
        : 'export const TTS_CONFIG = {};';
    const configBody = `${ttsConfig}
export const AI_LIMITS = {};
export const OCR_CONFIG = {};
export const ARTICLE_IMPORT = {};
export const SUPABASE = {};
export const QA_CHECK = {};
export const SYNC = { endpoint: '' };`;

    const stats = { ttsRequests: 0, newPages: 0 };
    const baseOrigin = new URL(BASE).origin;
    await context.route('**/*', (route) => {
        let url;
        try { url = new URL(route.request().url()); } catch (_) { return route.abort(); }
        if (url.origin !== baseOrigin) return route.abort();
        return route.continue();
    });
    await context.route('**/ai-config.js', (route) => route.fulfill({ contentType: 'application/javascript', body: configBody }));
    await context.route(TTS_HOST + '/**', (route) => {
        stats.ttsRequests += 1;
        return route.fulfill({
            status: 200,
            headers: { 'Content-Type': 'audio/mpeg', 'Content-Disposition': 'attachment; filename="tts.mp3"' },
            body: 'ID3mock-audio'
        });
    });

    const page = await context.newPage();
    context.on('page', () => { stats.newPages += 1; });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error && error.message ? error.message : error)));

    await mock.installProviderRoutes(page, async ({ route, prompt }) => mock.jsonReply(route, mock.translatedParagraphReply(prompt)));

    await page.goto(BASE + '#a', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
        const modal = document.getElementById('app-modal');
        if (modal && !modal.classList.contains('hidden')) modal.querySelector('.modal-close-btn')?.click();
    });
    return { context, page, stats, pageErrors };
}

const tInPage = (page, key, params) => page.evaluate(async ({ key, params }) => {
    const mod = await import('/modules/i18n.js');
    return mod.t(key, params);
}, { key, params });

const setLocale = (page, locale) => page.evaluate(async (loc) => {
    const mod = await import('/modules/i18n.js');
    mod.setLocale(loc);
}, locale);

const clearToasts = (page) => page.evaluate(() => {
    const box = document.getElementById('message-container');
    if (box) box.replaceChildren();
});

const lastToast = (page) => page.evaluate(() => {
    const list = document.querySelectorAll('.message-toast__text');
    return list.length ? list[list.length - 1].textContent.trim() : '';
});

const modalState = (page, selector = '.options-modal-overlay') => page.evaluate((dialogSelector) => {
    const overlay = document.querySelector(dialogSelector);
    if (!overlay) return { open: false };
    const boxes = {};
    overlay.querySelectorAll('input[type="checkbox"][data-option-key]').forEach((box) => {
        boxes[box.getAttribute('data-option-key')] = box.checked;
    });
    const formatGroup = overlay.querySelector('.radio-group[data-option-key="format"]');
    const fullText = overlay.querySelector('input[data-option-key="fullText"]');
    return {
        open: true,
        title: overlay.querySelector('h3')?.textContent.trim() || '',
        description: overlay.querySelector('.om-desc')?.textContent.trim() || '',
        boxes,
        formats: Array.from(formatGroup?.querySelectorAll('input[type="radio"]') || [], (input) => input.value),
        format: formatGroup?.querySelector('input:checked')?.value || null,
        fullTextAvailable: !!fullText && !fullText.disabled && !!fullText.closest('.om-row')?.getClientRects().length
    };
}, selector);

const setDialogCheckbox = (page, key, checked) => page.evaluate(({ selector, key, checked }) => {
    const box = document.querySelector(`${selector} input[type="checkbox"][data-option-key="${key}"]`);
    if (!box) throw new Error('checkbox not found: ' + key);
    if (box.checked !== checked) box.click();
}, { selector: EXPORT_DIALOG, key, checked });

const setDialogFormat = (page, format) => page.evaluate(({ selector, format }) => {
    const radio = document.querySelector(`${selector} .radio-group[data-option-key="format"] input[value="${format}"]`);
    if (!radio) throw new Error('format radio not found: ' + format);
    radio.click();
}, { selector: EXPORT_DIALOG, format });

async function confirmExport(page) {
    const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 30000 }),
        page.click(`${EXPORT_DIALOG} #confirm-btn`)
    ]);
    await page.waitForSelector(EXPORT_DIALOG, { state: 'detached', timeout: 10000 });
    return download;
}

async function failThenRetryExport(page, locale) {
    const before = await modalState(page, EXPORT_DIALOG);
    const overlay = await page.$(EXPORT_DIALOG);
    let downloads = 0;
    const onDownload = () => { downloads += 1; };
    page.on('download', onDownload);
    await clearToasts(page);
    await page.evaluate(() => {
        const state = { original: URL.createObjectURL, failures: 0 };
        window.__htmlDownloadFailure = state;
        URL.createObjectURL = function (blob) {
            if (blob.type.startsWith('text/html') && state.failures === 0) {
                state.failures += 1;
                throw new Error('injected_html_download_failure');
            }
            return state.original.call(this, blob);
        };
    });
    try {
        await page.click(`${EXPORT_DIALOG} #confirm-btn`);
        await page.waitForFunction((selector) => {
            const confirm = document.querySelector(`${selector} #confirm-btn`);
            return window.__htmlDownloadFailure?.failures === 1 && confirm && !confirm.disabled;
        }, EXPORT_DIALOG, { timeout: 15000 });
        const failed = await modalState(page, EXPORT_DIALOG);
        const failureText = await tInPage(page, 'article.readingExportFailed');
        const retryText = await tInPage(page, 'article.exportRetry');
        check(`${locale} 匯出失敗保留原對話框且不下載`, await overlay.evaluate((element) => element.isConnected) && downloads === 0, JSON.stringify(failed));
        check(`${locale} 匯出失敗保留格式及範圍`, failed.format === before.format && JSON.stringify(failed.boxes) === JSON.stringify(before.boxes), JSON.stringify(failed));
        check(`${locale} 失敗訊息及重試按鈕走翻譯`, ((await lastToast(page)) === failureText || (await page.textContent(EXPORT_DIALOG)).includes(failureText))
            && (await page.textContent(`${EXPORT_DIALOG} #confirm-btn`)).trim() === retryText, await page.textContent(EXPORT_DIALOG));
        const download = await confirmExport(page);
        check(`${locale} 同一對話框重試成功後關閉且只下載一次`, downloads === 1 && !(await overlay.evaluate((element) => element.isConnected)), String(downloads));
        return download;
    } finally {
        page.off('download', onDownload);
        await page.evaluate(() => {
            URL.createObjectURL = window.__htmlDownloadFailure.original;
            delete window.__htmlDownloadFailure;
        });
        await overlay.dispose();
    }
}

async function openArticle(page, docs, id) {
    await mock.seedDocs(page, docs);
    for (let attempt = 0; attempt < 6; attempt += 1) {
        const count = await page.evaluate(async (articleId) => {
            const store = await import('/modules/article-store.js');
            const list = await store.reloadScope();
            return list.filter((item) => item.articleId === articleId).length;
        }, id);
        if (count > 0) break;
        await page.waitForTimeout(300);
    }
    await page.evaluate(() => document.getElementById('article-history-btn').click());
    await page.waitForSelector(`.ar-history-item[data-key="${id}"] .ar-history-open`, { timeout: 15000 });
    await page.evaluate((articleId) => {
        document.querySelector(`.ar-history-item[data-key="${articleId}"] .ar-history-open`)?.click();
    }, id);
    await page.waitForSelector('.paragraph-pair[data-paragraph-index="0"]', { timeout: 15000 });
}

async function seedReadingData(page, articleId, { body = EXPORT_BODY, prefix = '' } = {}) {
    return page.evaluate(async ({ id, body, prefix }) => {
        const r = await import('/modules/reading-store.js');
        const { contentVersionOf, locateTextAnchor } = await import('/shared/reading-protocol.mjs');
        const located = locateTextAnchor(body, 'reading');
        if (!located.unique) throw new Error('export fixture requires a unique reading anchor');
        const item = await r.upsertLearningItem({
            id: `${prefix}export_item`,
            articleId: id,
            kind: 'word',
            contentVersion: contentVersionOf(body),
            anchor: located.anchor,
            positionUncertain: false,
            marked: true,
            note: `${prefix}EXPORT_NOTE_MARKER`
        });
        const conv = await r.ensureConversation({ articleId: id, title: `${prefix}EXPORT_CHAT` });
        if (!conv.ok) return { ok: false, error: conv.error };
        const user = await r.appendMessage({ conversationId: conv.conversation.id, role: 'user', content: `${prefix}CHAT_QUESTION_MARKER` });
        const assistant = await r.appendMessage({ conversationId: conv.conversation.id, role: 'assistant', content: `${prefix}CHAT_ANSWER_MARKER` });
        return { ok: item.ok && user.ok && assistant.ok, conversationId: conv.conversation.id, contentVersion: item.entity?.contentVersion };
    }, { id: articleId, body, prefix });
}

async function checkHtmlDownload(page, download, { locale, title, includeChat = true }) {
    const html = fs.readFileSync(await download.path(), 'utf8');
    const content = await page.evaluate((source) => {
        const doc = new DOMParser().parseFromString(source, 'text/html');
        return {
            doctype: doc.doctype?.name,
            lang: doc.documentElement.lang,
            title: doc.title,
            heading: doc.querySelector('.edition-header h1')?.textContent,
            original: doc.querySelector('#original-text')?.textContent,
            marks: Array.from(doc.querySelectorAll('#original-text .text-mark'), (mark) => mark.textContent),
            words: Array.from(doc.querySelectorAll('#words .learning-card h3'), (heading) => heading.textContent),
            detached: doc.querySelectorAll('#detached .learning-card').length,
            notes: Array.from(doc.querySelectorAll('.item-note .markdown'), (note) => note.textContent),
            scopeHeading: doc.querySelector('.scope-notice h2')?.textContent,
            scopeNotice: doc.querySelector('.scope-notice > p')?.textContent,
            chat: !!doc.querySelector('#chat'),
            chatTitle: doc.querySelector('#chat .conversation h3')?.textContent,
            messages: Array.from(doc.querySelectorAll('#chat .message .markdown'), (message) => message.textContent)
        };
    }, html);
    const editionTitle = await tInPage(page, 'article.editionTitle');
    const snapshotTitle = await tInPage(page, 'article.editionLocalSnapshot');
    const scopeNotice = await tInPage(page, 'article.editionScopeNotice');
    check(`${locale} 真實下載為 HTML 文件`, /\.html$/i.test(download.suggestedFilename()) && content.doctype === 'html', download.suggestedFilename());
    check(`${locale} HTML 標題與語言正確`, content.lang === locale && content.heading === title && content.title === `${title} · ${editionTitle}`, JSON.stringify(content));
    check(`${locale} HTML 顯示翻譯後的本機快照範圍`, content.scopeHeading === snapshotTitle && content.scopeNotice === scopeNotice, `${content.scopeHeading} / ${content.scopeNotice}`);
    check(`${locale} HTML 一律包含完整原文`, content.original === EXPORT_BODY, content.original);
    check(`${locale} 有效錨點落在原文及單字記錄，沒有錯放至游離區`, content.marks.includes('reading') && content.words.includes('reading') && content.detached === 0, JSON.stringify(content));
    check(`${locale} HTML 包含已保存筆記`, content.notes.some((note) => note.includes('EXPORT_NOTE_MARKER')), JSON.stringify(content.notes));
    check(`${locale} HTML 排除其他文章與閱讀資料`, !html.includes('OTHER_ARTICLE_BODY_MARKER') && !html.includes('OTHER_EXPORT_NOTE_MARKER') && !html.includes('OTHER_CHAT_QUESTION_MARKER'), html.slice(-200));
    check(`${locale} HTML 對話範圍符合選擇`, includeChat
        ? content.chat && content.chatTitle === 'EXPORT_CHAT' && content.messages.some((message) => message.includes('CHAT_QUESTION_MARKER')) && content.messages.some((message) => message.includes('CHAT_ANSWER_MARKER'))
        : !content.chat && !html.includes('CHAT_QUESTION_MARKER') && !html.includes('CHAT_ANSWER_MARKER'), JSON.stringify(content.messages));
}

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: mock.CHROME });

    // ── 情境 1：無遠端 TTS ─────────────────────────────────────────
    console.log('\n[情境 1] 無遠端 TTS：播放可用本機、下載給提示不開新分頁');
    {
        const { context, page, stats, pageErrors } = await makePage(browser, { tts: 'none' });
        await page.fill('#article-input', 'The reading room opens at eight. Visitors sign the book.');
        await page.waitForTimeout(200);
        const aria = await page.getAttribute('#download-audio-btn', 'aria-label');
        const title = await page.getAttribute('#download-audio-btn', 'title');
        const needsRemote = await tInPage(page, 'article.downloadNeedsRemote');
        check('下載鈕 aria-label 標示需要遠端 TTS', aria === needsRemote, `${aria} / ${needsRemote}`);
        check('下載鈕 title 標示需要遠端 TTS', title === needsRemote, title);
        check('未設定遠端 TTS 時按鈕仍可見', await page.isVisible('#download-audio-btn'), 'hidden');

        await page.click('#read-article-btn');
        await page.waitForTimeout(400);
        const spoken = await page.evaluate(() => window.__spoken || []);
        check('播放仍可用本機語音', spoken.length > 0 && spoken.join(' ').includes('reading room'), JSON.stringify(spoken.slice(0, 2)));

        await clearToasts(page);
        await page.click('#download-audio-btn');
        await page.waitForTimeout(400);
        check('按下載顯示需要遠端 TTS 的提示', (await lastToast(page)) === needsRemote, await lastToast(page));
        check('未設定遠端 TTS 不請求 TTS', stats.ttsRequests === 0, String(stats.ttsRequests));
        check('未設定遠端 TTS 不開新分頁', stats.newPages === 0, String(stats.newPages));

        // locale 切換後 aria 仍需重新套用
        await setLocale(page, 'zh-HK');
        await page.waitForTimeout(200);
        const hkAria = await page.getAttribute('#download-audio-btn', 'aria-label');
        const hkNeedsRemote = await tInPage(page, 'article.downloadNeedsRemote');
        check('切換 zh-HK 後下載鈕標示跟著更新', hkAria === hkNeedsRemote, `${hkAria} / ${hkNeedsRemote}`);
        check('無頁面錯誤', pageErrors.length === 0, pageErrors.join(' | '));
        await context.close();
    }

    // ── 情境 2：全文過長阻擋、句子模式確認、取消與確認 ────────────────
    console.log('\n[情境 2] 全文長文阻擋、範圍／host 確認、取消不開連結');
    {
        const { context, page, stats, pageErrors } = await makePage(browser, { tts: 'configured' });
        await page.fill('#article-input', LONG_TEXT);
        await page.waitForTimeout(300);
        const configuredLabel = await tInPage(page, 'article.downloadAudio');
        check('已設定遠端 TTS 時 aria-label 回到下載語音', (await page.getAttribute('#download-audio-btn', 'aria-label')) === configuredLabel, 'label');

        await clearToasts(page);
        await page.click('#download-audio-btn');
        await page.waitForTimeout(500);
        const longToast = await lastToast(page);
        const longText = await tInPage(page, 'article.downloadLongText');
        check('全文 10k 字下載被阻擋', longToast === longText, `${longToast} / ${longText}`);
        check('全文被阻擋時不開確認框', (await modalState(page)).open === false, JSON.stringify(await modalState(page)));
        check('全文被阻擋時不請求 TTS', stats.ttsRequests === 0, String(stats.ttsRequests));

        await page.selectOption('#reading-mode', 'sentence');
        await page.waitForTimeout(200);
        await clearToasts(page);
        await page.click('#download-audio-btn');
        await page.waitForSelector('.options-modal-overlay', { timeout: 5000 });
        const dialog = await modalState(page);
        const scopeLabel = await tInPage(page, 'article.downloadScope', { scope: await tInPage(page, 'article.sentence') });
        check('句子模式可進入確認框', dialog.open === true, JSON.stringify(dialog));
        check('確認框顯示下載範圍', dialog.description.includes(scopeLabel), dialog.description);
        check('確認框顯示有效 TTS host', dialog.description.includes('tts.mock'), dialog.description);
        check('確認框不洩漏 api_key', !JSON.stringify(dialog).includes(TTS_KEY), dialog.description);

        await page.click('.options-modal-overlay #cancel-btn');
        await page.waitForTimeout(400);
        check('取消確認不請求 TTS', stats.ttsRequests === 0, String(stats.ttsRequests));
        check('取消確認不開新分頁', stats.newPages === 0, String(stats.newPages));

        await clearToasts(page);
        await page.click('#download-audio-btn');
        await page.waitForSelector('.options-modal-overlay', { timeout: 5000 });
        await page.click('.options-modal-overlay #confirm-btn');
        await page.waitForTimeout(900);
        check('確認後送出 TTS 下載請求', stats.ttsRequests >= 1, String(stats.ttsRequests));
        const openedToast = await lastToast(page);
        const openedText = await tInPage(page, 'article.downloadLinkOpened');
        check('確認後提示已開啟下載連結', openedToast === openedText, `${openedToast} / ${openedText}`);
        check('提示不宣稱下載完成', !/下載完成|下载完成|download complete/i.test(openedToast), openedToast);
        const leaks = await page.evaluate((key) => document.body.innerHTML.includes(key), TTS_KEY);
        check('畫面文字不洩漏 api_key', leaks === false, String(leaks));
        check('無頁面錯誤', pageErrors.length === 0, pageErrors.join(' | '));
        await context.close();
    }

    // ── 情境 3：HTML／Markdown、雙入口與獨立備份 ───────────────────
    console.log('\n[情境 3] 預設 HTML、Markdown 範圍、失敗重試、獨立 JSON 備份');
    {
        const { context, page, pageErrors } = await makePage(browser, { tts: 'configured' });
        await openArticle(page, [
            recordDoc('art_export', 'Export article', EXPORT_BODY, EXPORT_ANALYSIS),
            recordDoc('art_other', 'Other article', OTHER_BODY, EXPORT_ANALYSIS)
        ], 'art_export');
        const seeded = await seedReadingData(page, 'art_export');
        const otherSeeded = await seedReadingData(page, 'art_other', { body: OTHER_BODY, prefix: 'OTHER_' });
        check('閱讀資料 seed 成功', seeded.ok && otherSeeded.ok, JSON.stringify({ seeded, otherSeeded }));

        const expectedSummary = await tInPage(page, 'article.exportScopeSummary', { items: 1, notes: 1, messages: 2 });
        const expectedVersion = seeded.contentVersion.slice(0, 12);
        const scopeTitle = await tInPage(page, 'article.exportScopeTitle');
        const noteOnly = await tInPage(page, 'article.exportNoteOnly');
        const htmlScope = await tInPage(page, 'article.exportHtmlScope');
        const localOnly = await tInPage(page, 'article.exportLocalOnly');

        await page.click('#article-reading-export-btn');
        await page.waitForSelector(EXPORT_DIALOG, { timeout: 8000 });
        const toolbarDialog = await modalState(page, EXPORT_DIALOG);
        check('頂部入口開閱讀匯出對話框', toolbarDialog.open && toolbarDialog.title === scopeTitle, JSON.stringify(toolbarDialog));
        check('對話框顯示目前文章標題與記錄／筆記／對話數量', toolbarDialog.description.includes('Export article') && toolbarDialog.description.includes(expectedSummary), toolbarDialog.description);
        check('對話框顯示原文版本', toolbarDialog.description.includes(expectedVersion), `${toolbarDialog.description} / ${expectedVersion}`);
        check('格式只有 HTML 與 Markdown，預設 HTML', JSON.stringify(toolbarDialog.formats) === JSON.stringify(['html', 'markdown']) && toolbarDialog.format === 'html', JSON.stringify(toolbarDialog));
        check('預設包含已保存對話，HTML 不提供全文範圍開關', toolbarDialog.boxes.chat === true && !toolbarDialog.fullTextAvailable, JSON.stringify(toolbarDialog));
        check('閱讀匯出沒有完整備份核取方塊', !Object.hasOwn(toolbarDialog.boxes, 'fullBackup'), JSON.stringify(toolbarDialog.boxes));
        check('HTML 範圍與只讀本機內容說明走翻譯', toolbarDialog.description.includes(htmlScope) && toolbarDialog.description.includes(localOnly), toolbarDialog.description);
        await page.click(`${EXPORT_DIALOG} #cancel-btn`);

        await page.click('#article-reading-records-btn');
        await page.waitForSelector('#reading-export-md', { timeout: 8000 });
        await page.click('#reading-export-md');
        await page.waitForSelector(EXPORT_DIALOG, { timeout: 8000 });
        const panelDialog = await modalState(page, EXPORT_DIALOG);
        check('面板入口開同一個閱讀匯出對話框', panelDialog.open && panelDialog.title === scopeTitle, JSON.stringify(panelDialog));
        check('兩個入口格式與預設範圍一致', panelDialog.format === toolbarDialog.format && JSON.stringify(panelDialog.formats) === JSON.stringify(toolbarDialog.formats)
            && JSON.stringify(panelDialog.boxes) === JSON.stringify(toolbarDialog.boxes), JSON.stringify(panelDialog));
        const defaultDownload = await confirmExport(page);
        await checkHtmlDownload(page, defaultDownload, { locale: 'zh-CN', title: 'Export article' });
        check('HTML 匯出完成提示走翻譯', (await lastToast(page)) === await tInPage(page, 'article.exportEditionDone'), await lastToast(page));
        check('HTML 成功後關閉匯出對話框', !(await modalState(page, EXPORT_DIALOG)).open, 'dialog still open');
        await page.click('.reading-panel-close');

        // Markdown 的全文開關只在該格式可用；明確取消對話後顯示 note-only。
        await page.click('#article-reading-export-btn');
        await page.waitForSelector(EXPORT_DIALOG, { timeout: 8000 });
        await setDialogFormat(page, 'markdown');
        await setDialogCheckbox(page, 'fullText', false);
        await setDialogCheckbox(page, 'chat', false);
        const markdownDialog = await modalState(page, EXPORT_DIALOG);
        check('Markdown 可設定全文範圍', markdownDialog.format === 'markdown' && markdownDialog.fullTextAvailable, JSON.stringify(markdownDialog));
        check('Markdown note-only 說明走翻譯', markdownDialog.description.includes(noteOnly), markdownDialog.description);
        await page.click(`${EXPORT_DIALOG} #cancel-btn`);

        // 舊助手呼叫不傳格式仍明確選 Markdown，並保持 note-only。
        const noteDownload = await exportReadingNote(page, { selector: '#article-reading-export-btn' });
        const noteContent = fs.readFileSync(await noteDownload.path(), 'utf8');
        check('助手預設輸出 Markdown 且含筆記', /\.md$/i.test(noteDownload.suggestedFilename()) && noteContent.includes('EXPORT_NOTE_MARKER'), noteDownload.suggestedFilename());
        check('助手預設 Markdown 不含全文或對話', !noteContent.includes('EXPORT_ARTICLE_BODY_MARKER') && !noteContent.includes('CHAT_QUESTION_MARKER') && !noteContent.includes('CHAT_ANSWER_MARKER'), noteContent.slice(0, 200));
        check('Markdown 匯出完成提示走翻譯', (await lastToast(page)) === await tInPage(page, 'article.readingExportDone'), await lastToast(page));
        check('Markdown 只包含目前文章閱讀資料', !noteContent.includes('OTHER_EXPORT_NOTE_MARKER'), noteContent.slice(-200));

        const fullDownload = await exportReadingNote(page, { selector: '#article-reading-export-btn', fullText: true, chat: true });
        const fullContent = fs.readFileSync(await fullDownload.path(), 'utf8');
        check('Markdown 勾選後輸出含全文', /\.md$/i.test(fullDownload.suggestedFilename()) && fullContent.includes('EXPORT_ARTICLE_BODY_MARKER'), fullContent.slice(0, 200));
        check('Markdown 勾選後輸出含已保存對話', fullContent.includes('CHAT_QUESTION_MARKER') && fullContent.includes('CHAT_ANSWER_MARKER'), fullContent.slice(0, 200));
        check('Markdown 勾選後仍排除其他文章資料', !fullContent.includes('OTHER_ARTICLE_BODY_MARKER') && !fullContent.includes('OTHER_EXPORT_NOTE_MARKER') && !fullContent.includes('OTHER_CHAT_QUESTION_MARKER'), fullContent.slice(-200));

        // 從不含全文的 Markdown 切回 HTML：全文仍完整，chat 選擇則保留。
        await page.click('#article-reading-export-btn');
        await page.waitForSelector(EXPORT_DIALOG, { timeout: 8000 });
        await setDialogFormat(page, 'markdown');
        await setDialogCheckbox(page, 'fullText', false);
        await setDialogCheckbox(page, 'chat', false);
        await setDialogFormat(page, 'html');
        const htmlDialog = await modalState(page, EXPORT_DIALOG);
        check('切回 HTML 後全文開關不可用，對話仍可排除', htmlDialog.format === 'html' && !htmlDialog.fullTextAvailable && htmlDialog.boxes.chat === false, JSON.stringify(htmlDialog));
        const retryDownload = await failThenRetryExport(page, 'zh-CN');
        await checkHtmlDownload(page, retryDownload, { locale: 'zh-CN', title: 'Export article', includeChat: false });

        // 完整 JSON 備份是獨立入口，不混用閱讀格式或範圍選項。
        await page.click('#article-reading-records-btn');
        await page.locator('.reading-tools > summary').click();
        await page.click('#reading-export-json');
        await page.waitForSelector(EXPORT_DIALOG, { timeout: 8000 });
        const backupDialog = await modalState(page, EXPORT_DIALOG);
        const backupTitle = await tInPage(page, 'article.readingExportAccountBackup');
        const backupDescription = await tInPage(page, 'article.exportBackupDescription');
        check('獨立 JSON 備份標題與範圍說明走翻譯', backupDialog.title === backupTitle && backupDialog.description.includes(backupDescription), JSON.stringify(backupDialog));
        check('JSON 備份對話框沒有閱讀格式與範圍控制', backupDialog.formats.length === 0 && !Object.hasOwn(backupDialog.boxes, 'fullText')
            && !Object.hasOwn(backupDialog.boxes, 'chat') && !Object.hasOwn(backupDialog.boxes, 'fullBackup'), JSON.stringify(backupDialog));
        await page.click(`${EXPORT_DIALOG} #cancel-btn`);
        const backupDownload = await exportReadingNote(page, { fullBackup: true, selector: '#article-reading-export-btn' });
        const backup = JSON.parse(fs.readFileSync(await backupDownload.path(), 'utf8'));
        const backupText = JSON.stringify(backup);
        check('助手 fullBackup 走獨立 JSON 並包含目前 scope 全部文章', /\.json$/i.test(backupDownload.suggestedFilename()) && backupText.includes('art_export')
            && backupText.includes('EXPORT_ARTICLE_BODY_MARKER') && backupText.includes('OTHER_ARTICLE_BODY_MARKER'), backup.kind);
        check('完整 JSON 含閱讀資料及對話', backupText.includes('export_item') && backupText.includes('EXPORT_NOTE_MARKER') && backupText.includes('CHAT_ANSWER_MARKER'), backup.kind);
        check('完整 JSON 標示 kind/schema', backup.kind === 'bdc-full-backup' && Number(backup.schemaVersion) >= 2, `${backup.kind}/${backup.schemaVersion}`);
        check('JSON 匯出完成提示走翻譯', (await lastToast(page)) === await tInPage(page, 'article.readingExportJsonDone'), await lastToast(page));
        check('無頁面錯誤', pageErrors.length === 0, pageErrors.join(' | '));

        // 無文章時不開空對話框
        const blank = await context.newPage();
        await blank.goto(BASE + '#a', { waitUntil: 'domcontentloaded' });
        await blank.waitForTimeout(1200);
        await blank.evaluate(() => {
            document.getElementById('app-modal')?.classList.add('hidden');
            document.getElementById('article-reading-export-btn').click();
        });
        await blank.waitForTimeout(400);
        const noArticleText = await blank.evaluate(async () => {
            const mod = await import('/modules/i18n.js');
            return mod.t('article.readingNoArticle');
        });
        const blankToast = await blank.evaluate(() => {
            const list = document.querySelectorAll('.message-toast__text');
            return list.length ? list[list.length - 1].textContent.trim() : '';
        });
        const blankModal = await blank.evaluate(() => !!document.querySelector('.options-modal-overlay'));
        check('無文章顯示提示', blankToast === noArticleText, `${blankToast} / ${noArticleText}`);
        check('無文章不開空對話框', blankModal === false, String(blankModal));
        await blank.close();
        await context.close();
    }

    // ── 情境 4：zh-HK 完整匯出互動與 TTS 文案 ──────────────────────
    console.log('\n[情境 4] zh-HK HTML 下載、重試、Markdown／JSON 與 TTS 文案');
    {
        const { context, page, pageErrors } = await makePage(browser, { tts: 'configured', locale: 'zh-HK' });
        await openArticle(page, [
            recordDoc('art_hk', 'HK article', EXPORT_BODY, EXPORT_ANALYSIS),
            recordDoc('art_hk_other', 'Other HK article', OTHER_BODY, EXPORT_ANALYSIS)
        ], 'art_hk');
        const seeded = await seedReadingData(page, 'art_hk');
        const otherSeeded = await seedReadingData(page, 'art_hk_other', { body: OTHER_BODY, prefix: 'OTHER_' });
        check('zh-HK 閱讀資料 seed 成功', seeded.ok && otherSeeded.ok, JSON.stringify({ seeded, otherSeeded }));
        await page.click('#article-reading-export-btn');
        await page.waitForSelector(EXPORT_DIALOG, { timeout: 8000 });
        const dialog = await modalState(page, EXPORT_DIALOG);
        const hkTitle = await tInPage(page, 'article.exportScopeTitle');
        const hkSummary = await tInPage(page, 'article.exportScopeSummary', { items: 1, notes: 1, messages: 2 });
        const hkHtmlScope = await tInPage(page, 'article.exportHtmlScope');
        const hkLocalOnly = await tInPage(page, 'article.exportLocalOnly');
        const hkHtml = await tInPage(page, 'article.exportHtml');
        const hkMarkdown = await tInPage(page, 'article.exportMarkdown');
        const dialogText = await page.textContent(EXPORT_DIALOG);
        check('zh-HK 匯出對話框標題正確', dialog.title === hkTitle, `${dialog.title} / ${hkTitle}`);
        check('zh-HK 匯出摘要正確', dialog.description.includes('HK article') && dialog.description.includes(hkSummary), dialog.description);
        check('zh-HK HTML 格式與本機範圍說明正確', dialog.format === 'html' && dialog.boxes.chat === true && !dialog.fullTextAvailable
            && dialog.description.includes(hkHtmlScope) && dialog.description.includes(hkLocalOnly), JSON.stringify(dialog));
        check('zh-HK 格式選項走翻譯', dialogText.includes(hkHtml) && dialogText.includes(hkMarkdown), dialogText);
        let cancelledDownloads = 0;
        const onCancelledDownload = () => { cancelledDownloads += 1; };
        page.on('download', onCancelledDownload);
        await page.click(`${EXPORT_DIALOG} #cancel-btn`);
        await page.waitForSelector(EXPORT_DIALOG, { state: 'detached', timeout: 8000 });
        check('zh-HK 取消匯出不下載', cancelledDownloads === 0, String(cancelledDownloads));
        page.off('download', onCancelledDownload);

        await page.click('#article-reading-export-btn');
        await page.waitForSelector(EXPORT_DIALOG, { timeout: 8000 });
        const htmlDownload = await failThenRetryExport(page, 'zh-HK');
        await checkHtmlDownload(page, htmlDownload, { locale: 'zh-HK', title: 'HK article' });
        check('zh-HK HTML 完成提示走翻譯', (await lastToast(page)) === await tInPage(page, 'article.exportEditionDone'), await lastToast(page));

        await page.click('#article-reading-records-btn');
        await page.waitForSelector('#reading-export-md', { timeout: 8000 });
        await page.click('#reading-export-md');
        await page.waitForSelector(EXPORT_DIALOG, { timeout: 8000 });
        await setDialogFormat(page, 'markdown');
        await setDialogCheckbox(page, 'fullText', false);
        await setDialogCheckbox(page, 'chat', false);
        const markdownDialog = await modalState(page, EXPORT_DIALOG);
        const hkOnly = await tInPage(page, 'article.exportNoteOnly');
        check('zh-HK Markdown note-only 說明正確', markdownDialog.fullTextAvailable && markdownDialog.description.includes(hkOnly), markdownDialog.description);
        const markdownDownload = await confirmExport(page);
        const markdown = fs.readFileSync(await markdownDownload.path(), 'utf8');
        check('zh-HK 明確選 Markdown 後只匯出目前文章筆記', /\.md$/i.test(markdownDownload.suggestedFilename()) && markdown.includes('EXPORT_NOTE_MARKER')
            && !markdown.includes('EXPORT_ARTICLE_BODY_MARKER') && !markdown.includes('CHAT_QUESTION_MARKER') && !markdown.includes('OTHER_EXPORT_NOTE_MARKER'), markdown.slice(0, 200));
        check('zh-HK Markdown 完成提示走翻譯', (await lastToast(page)) === await tInPage(page, 'article.readingExportDone'), await lastToast(page));

        await page.locator('.reading-tools > summary').click();
        await page.click('#reading-export-json');
        await page.waitForSelector(EXPORT_DIALOG, { timeout: 8000 });
        const backupDialog = await modalState(page, EXPORT_DIALOG);
        const hkBackupTitle = await tInPage(page, 'article.readingExportAccountBackup');
        const hkBackupDescription = await tInPage(page, 'article.exportBackupDescription');
        check('zh-HK 獨立備份對話框文案正確且沒有閱讀格式控制', backupDialog.title === hkBackupTitle && backupDialog.description.includes(hkBackupDescription)
            && backupDialog.formats.length === 0 && Object.keys(backupDialog.boxes).length === 0, JSON.stringify(backupDialog));
        const backupDownload = await confirmExport(page);
        const backup = JSON.parse(fs.readFileSync(await backupDownload.path(), 'utf8'));
        check('zh-HK JSON 備份實際下載目前 scope 全部文章與筆記', /\.json$/i.test(backupDownload.suggestedFilename()) && backup.kind === 'bdc-full-backup'
            && JSON.stringify(backup).includes('OTHER_ARTICLE_BODY_MARKER') && JSON.stringify(backup).includes('EXPORT_NOTE_MARKER'), backup.kind);
        check('zh-HK JSON 完成提示走翻譯', (await lastToast(page)) === await tInPage(page, 'article.readingExportJsonDone'), await lastToast(page));
        await page.click('.reading-panel-close');

        await page.selectOption('#reading-mode', 'sentence');
        await page.click('#download-audio-btn');
        await page.waitForSelector('.options-modal-overlay', { timeout: 5000 });
        const scopeLine = await tInPage(page, 'article.downloadScope', { scope: await tInPage(page, 'article.sentence') });
        const dlDialog = await modalState(page);
        check('zh-HK 下載確認範圍正確', dlDialog.description.includes(scopeLine), dlDialog.description);
        await page.click('.options-modal-overlay #cancel-btn');
        check('無頁面錯誤', pageErrors.length === 0, pageErrors.join(' | '));
        await context.close();
    }

    await browser.close();
    process.exitCode = finish() === 0 ? 0 : 1;
})().catch((error) => {
    console.error(error);
    // 測試失敗時可能還有未關閉的瀏覽器連線；直接結束，不要卡住 CI。
    process.exit(1);
});
