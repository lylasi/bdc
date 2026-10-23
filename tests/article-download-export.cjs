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
 *   - 預設 note-only（不含全文與對話）；勾選後輸出含對應區段
 *   - 完整 JSON 備份含目前 scope 的文章與閱讀資料
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

const modalState = (page) => page.evaluate(() => {
    const overlay = document.querySelector('.options-modal-overlay');
    if (!overlay) return { open: false };
    const boxes = {};
    overlay.querySelectorAll('input[type="checkbox"][data-option-key]').forEach((box) => {
        boxes[box.getAttribute('data-option-key')] = box.checked;
    });
    return {
        open: true,
        title: overlay.querySelector('h3')?.textContent.trim() || '',
        description: overlay.querySelector('.om-desc')?.textContent.trim() || '',
        boxes
    };
});

const setDialogCheckbox = (page, key, checked) => page.evaluate(({ key, checked }) => {
    const box = document.querySelector(`.options-modal-overlay input[type="checkbox"][data-option-key="${key}"]`);
    if (!box) throw new Error('checkbox not found: ' + key);
    if (box.checked !== checked) box.click();
}, { key, checked });

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

async function seedReadingData(page, articleId) {
    return page.evaluate(async (id) => {
        const r = await import('/modules/reading-store.js');
        const item = await r.upsertLearningItem({
            id: 'export_item',
            articleId: id,
            kind: 'word',
            contentVersion: 'cv1',
            anchor: { start: 4, end: 11, quote: 'reading' },
            note: 'EXPORT_NOTE_MARKER'
        });
        const conv = await r.ensureConversation({ articleId: id, title: 'EXPORT_CHAT' });
        if (!conv.ok) return { ok: false, error: conv.error };
        const user = await r.appendMessage({ conversationId: conv.conversation.id, role: 'user', content: 'CHAT_QUESTION_MARKER' });
        const assistant = await r.appendMessage({ conversationId: conv.conversation.id, role: 'assistant', content: 'CHAT_ANSWER_MARKER' });
        return { ok: item.ok && user.ok && assistant.ok, conversationId: conv.conversation.id };
    }, articleId);
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

    // ── 情境 3：匯出範圍與雙入口 ──────────────────────────────────
    console.log('\n[情境 3] 匯出範圍對話框、預設 note-only、勾選內容、完整備份');
    {
        const { context, page, pageErrors } = await makePage(browser, { tts: 'configured' });
        await openArticle(page, [recordDoc('art_export', 'Export article', EXPORT_BODY, EXPORT_ANALYSIS)], 'art_export');
        const seeded = await seedReadingData(page, 'art_export');
        check('閱讀資料 seed 成功', seeded.ok === true, JSON.stringify(seeded));

        const expectedSummary = await tInPage(page, 'article.exportScopeSummary', { items: 1, notes: 1, messages: 2 });
        const expectedVersion = await page.evaluate(async (body) => {
            const mod = await import('/shared/reading-protocol.mjs');
            return String(mod.contentVersionOf(body)).slice(0, 12);
        }, EXPORT_BODY);
        const scopeTitle = await tInPage(page, 'article.exportScopeTitle');
        const noteOnly = await tInPage(page, 'article.exportNoteOnly');

        await page.click('#article-reading-export-btn');
        await page.waitForSelector('.options-modal-overlay', { timeout: 8000 });
        const toolbarDialog = await modalState(page);
        check('頂部入口開範圍對話框', toolbarDialog.open && toolbarDialog.title === scopeTitle, JSON.stringify(toolbarDialog));
        check('對話框顯示記錄／筆記／對話數量', toolbarDialog.description.includes(expectedSummary), toolbarDialog.description);
        check('對話框顯示原文版本', toolbarDialog.description.includes(expectedVersion), `${toolbarDialog.description} / ${expectedVersion}`);
        check('預設不勾全文與對話', toolbarDialog.boxes.fullText === false && toolbarDialog.boxes.chat === false, JSON.stringify(toolbarDialog.boxes));
        check('預設說明 note-only', toolbarDialog.description.includes(noteOnly), toolbarDialog.description);
        await page.click('.options-modal-overlay #cancel-btn');
        await page.waitForTimeout(300);

        await page.click('#article-reading-records-btn');
        await page.waitForSelector('#reading-export-md', { timeout: 8000 });
        await page.click('#reading-export-md');
        await page.waitForSelector('.options-modal-overlay', { timeout: 8000 });
        const panelDialog = await modalState(page);
        check('面板入口開同一個範圍對話框', panelDialog.open && panelDialog.title === scopeTitle, JSON.stringify(panelDialog));
        check('兩個入口預設一致', JSON.stringify(panelDialog.boxes) === JSON.stringify(toolbarDialog.boxes), `${JSON.stringify(panelDialog.boxes)} / ${JSON.stringify(toolbarDialog.boxes)}`);
        await page.click('.options-modal-overlay #cancel-btn');
        await page.waitForTimeout(300);

        // 預設 note-only 匯出
        await page.click('#article-reading-export-btn');
        await page.waitForSelector('.options-modal-overlay', { timeout: 8000 });
        const [defaultDownload] = await Promise.all([
            page.waitForEvent('download', { timeout: 15000 }),
            page.click('.options-modal-overlay #confirm-btn')
        ]);
        const defaultContent = fs.readFileSync(await defaultDownload.path(), 'utf8');
        check('預設輸出含筆記', defaultContent.includes('EXPORT_NOTE_MARKER'), defaultContent.slice(0, 200));
        check('預設輸出不含全文', !defaultContent.includes('EXPORT_ARTICLE_BODY_MARKER'), defaultContent.slice(0, 200));
        check('預設輸出不含對話', !defaultContent.includes('CHAT_QUESTION_MARKER') && !defaultContent.includes('CHAT_ANSWER_MARKER'), defaultContent.slice(0, 200));
        const doneText = await tInPage(page, 'article.readingExportDone');
        check('匯出完成提示走翻譯', (await lastToast(page)) === doneText, await lastToast(page));

        // 勾選全文與對話後匯出
        await page.click('#article-reading-export-btn');
        await page.waitForSelector('.options-modal-overlay', { timeout: 8000 });
        await setDialogCheckbox(page, 'fullText', true);
        await setDialogCheckbox(page, 'chat', true);
        const checkedDialog = await modalState(page);
        check('勾選後 note-only 說明消失', !checkedDialog.description.includes(noteOnly), checkedDialog.description);
        const [fullDownload] = await Promise.all([
            page.waitForEvent('download', { timeout: 15000 }),
            page.click('.options-modal-overlay #confirm-btn')
        ]);
        const fullContent = fs.readFileSync(await fullDownload.path(), 'utf8');
        check('勾選後輸出含全文', fullContent.includes('EXPORT_ARTICLE_BODY_MARKER'), fullContent.slice(0, 200));
        check('勾選後輸出含對話', fullContent.includes('CHAT_QUESTION_MARKER') && fullContent.includes('CHAT_ANSWER_MARKER'), fullContent.slice(0, 200));

        // 完整 JSON 備份
        await page.click('#article-reading-export-btn');
        await page.waitForSelector('.options-modal-overlay', { timeout: 8000 });
        await setDialogCheckbox(page, 'fullBackup', true);
        const backupLabel = await tInPage(page, 'article.exportFullBackup');
        const backupDialog = await modalState(page);
        check('完整備份選項說明帳戶／端點與檔案較大', backupDialog.description.includes(expectedSummary), backupDialog.description);
        check('完整備份選項文案走翻譯', !!(await page.textContent('.options-modal-overlay')).includes(backupLabel.slice(0, 8)), backupLabel);
        const [backupDownload] = await Promise.all([
            page.waitForEvent('download', { timeout: 20000 }),
            page.click('.options-modal-overlay #confirm-btn')
        ]);
        const backup = JSON.parse(fs.readFileSync(await backupDownload.path(), 'utf8'));
        const backupText = JSON.stringify(backup);
        check('完整 JSON 含目前 scope 文章', backupText.includes('art_export') && backupText.includes('EXPORT_ARTICLE_BODY_MARKER'), backup.kind);
        check('完整 JSON 含閱讀資料', backupText.includes('export_item') && backupText.includes('EXPORT_NOTE_MARKER'), backup.kind);
        check('完整 JSON 標示 kind/schema', backup.kind === 'bdc-full-backup' && Number(backup.schemaVersion) >= 2, `${backup.kind}/${backup.schemaVersion}`);
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

    // ── 情境 4：zh-HK 動態文案 ───────────────────────────────────
    console.log('\n[情境 4] zh-HK 動態文案');
    {
        const { context, page, pageErrors } = await makePage(browser, { tts: 'configured', locale: 'zh-HK' });
        await openArticle(page, [recordDoc('art_hk', 'HK article', EXPORT_BODY, EXPORT_ANALYSIS)], 'art_hk');
        await seedReadingData(page, 'art_hk');
        await page.click('#article-reading-export-btn');
        await page.waitForSelector('.options-modal-overlay', { timeout: 8000 });
        const dialog = await modalState(page);
        const hkTitle = await tInPage(page, 'article.exportScopeTitle');
        const hkSummary = await tInPage(page, 'article.exportScopeSummary', { items: 1, notes: 1, messages: 2 });
        const hkOnly = await tInPage(page, 'article.exportNoteOnly');
        check('zh-HK 匯出對話框標題正確', dialog.title === hkTitle, `${dialog.title} / ${hkTitle}`);
        check('zh-HK 匯出摘要正確', dialog.description.includes(hkSummary), dialog.description);
        check('zh-HK note-only 說明正確', dialog.description.includes(hkOnly), dialog.description);
        await page.click('.options-modal-overlay #cancel-btn');
        await page.waitForTimeout(200);
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
