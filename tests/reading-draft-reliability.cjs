/**
 * 閱讀筆記草稿可靠性：關閉、篩選隱藏與 JSON 匯出前都必須保存；
 * 保存失敗不得丟草稿或靜默關閉，必須保留可重試入口。
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/reading-draft-reliability.cjs
 */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exportReadingNote } = require('./helpers/reading-export.cjs');

const PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${PORT}/`;
const ENDPOINT = process.env.TEST_SYNC_ENDPOINT || 'http://127.0.0.1:19999/test-endpoint';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const ARTICLE = {
    id: 'art_draft_reliability',
    title: 'Draft Reliability',
    body: 'We look forward to meeting you.\n\nPlease review the attached document before Friday.',
    sentence: 'We look forward to meeting you.',
    result: {
        chinese_translation: '我們期待與你見面。',
        paragraph_analysis: [{ chinese_translation: '我們期待與你見面。', sentences: [{ en: 'We look forward to meeting you.' }] }],
        detailed_analysis: [{ word: 'look', analysis: { meaning: '看；期待' } }]
    }
};

async function newPage(browser) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith('/ai-config.js')) {
            return route.fulfill({ contentType: 'application/javascript', body: 'export const SYNC={endpoint: ""}; export const TTS_CONFIG={}, AI_LIMITS={}, OCR_CONFIG={}, ARTICLE_IMPORT={}, SUPABASE={};' });
        }
        if (url.origin !== `http://127.0.0.1:${PORT}`) return route.abort();
        return route.continue();
    });
    await context.addInitScript(({ endpoint }) => {
        window.__BDC_SYNC_ENDPOINT__ = endpoint;
        try {
            const raw = localStorage.getItem('pen_global_settings');
            const parsed = raw ? JSON.parse(raw) : {};
            parsed.language = { ...(parsed.language || {}), interfaceLocale: 'zh-CN' };
            localStorage.setItem('pen_global_settings', JSON.stringify(parsed));
        } catch (_) {}
    }, { endpoint: ENDPOINT });
    const page = await context.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    await page.evaluate(() => {
        const modal = document.getElementById('app-modal');
        if (modal && !modal.classList.contains('hidden')) modal.querySelector('.modal-close-btn')?.click();
    });
    return { context, page };
}

async function seed(page) {
    return page.evaluate(async (article) => {
        const art = await import('/modules/article-store.js');
        const rd = await import('/modules/reading-store.js');
        const { contentVersionOf } = await import('/shared/reading-protocol.mjs');
        await art.initArticleStore();
        await rd.initReadingStore();
        await art.saveArticle({ articleId: article.id, article: article.body, title: article.title, sourceType: 'paste', result: article.result });
        const version = contentVersionOf(article.body);
        const phrase = await rd.upsertLearningItem({
            articleId: article.id, contentVersion: version, kind: 'phrase',
            anchor: { start: 3, end: 18, quote: 'look forward to' },
            sentence: article.sentence,
            explanation: { language: 'zh-CN', result: { analysis: { meaning: '期待' } }, generatedAt: new Date().toISOString() },
            note: 'original phrase note'
        }, { markViewed: true });
        const sentence = await rd.upsertLearningItem({
            articleId: article.id, contentVersion: version, kind: 'sentence',
            anchor: { start: 21, end: 59, quote: 'We look forward to meeting you.' },
            sentence: article.sentence,
            note: 'original sentence note'
        }, { markViewed: true });
        const st = await import('/modules/state.js');
        st.setCurrentArticleId(article.id);
        st.setCurrentWordbookId(article.id);
        return { phraseId: phrase.entity.id, sentenceId: sentence.entity.id };
    }, ARTICLE);
}

async function openArticle(page) {
    if (!(await page.locator('#article-btn').isVisible())) {
        await page.click('#nav-more-btn').catch(() => {});
        await page.waitForTimeout(150);
    }
    await page.click('#article-btn');
    await page.waitForTimeout(250);
    await page.evaluate(async (id) => {
        const st = await import('/modules/state.js');
        st.setCurrentArticleId(id);
        const art = await import('/features/article/article.js');
        await art.showCurrentArticleIfAvailable();
    }, ARTICLE.id);
    await page.waitForTimeout(900);
}

// P2-T2：次要操作收進 details.tooltip-more（預設收起），直接操作前必須先展開。
async function openTooltipMore(page, actionSelector = '.btn-note-item') {
    await page.waitForSelector('#word-analysis-tooltip details.tooltip-more', { timeout: 5000 });
    await page.evaluate(() => {
        const details = document.querySelector('#word-analysis-tooltip details.tooltip-more');
        if (details && !details.open) details.open = true;
    });
    await page.waitForSelector(`#word-analysis-tooltip details.tooltip-more[open] ${actionSelector}`, { state: 'visible', timeout: 5000 });
}

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: CHROME });
    const results = [];
    try {
        const { context, page } = await newPage(browser);
        const ids = await seed(page);
        await openArticle(page);
        await page.click('#article-reading-records-btn');
        await page.waitForTimeout(400);

        // ── 1. 面板保存失敗：不關閉、保留輸入，可重試 ────────────────────
        await page.evaluate(async () => {
            const actions = await import('/modules/reading-actions.js');
            window.__noteFailActive = true;
            actions.__setNoteSaveInterceptorForTests(async () => {
                if (window.__noteFailActive) return { ok: false, error: 'injected_save_failure' };
                return null;
            });
        });
        await page.locator(`[data-item-id="${ids.phraseId}"] [data-action="expand"]`).click();
        const phraseArea = page.locator(`[data-note-id="${ids.phraseId}"]`);
        await phraseArea.fill('draft typed before closing');
        await page.click('.reading-panel-close');
        await page.waitForTimeout(400);
        const afterFailedClose = await page.evaluate(async (phraseId) => {
            const rd = await import('/modules/reading-store.js');
            return {
                panelOpen: !document.getElementById('article-reading-panel')?.classList.contains('hidden'),
                inputValue: document.querySelector(`[data-note-id="${phraseId}"]`)?.value,
                stored: rd.getLearningItem(phraseId)?.note
            };
        }, ids.phraseId);
        try {
            assert.equal(afterFailedClose.panelOpen, true, JSON.stringify(afterFailedClose));
            assert.equal(afterFailedClose.inputValue, 'draft typed before closing', JSON.stringify(afterFailedClose));
            assert.equal(afterFailedClose.stored, 'original phrase note', JSON.stringify(afterFailedClose));
            results.push({ name: 'panel close with save failure keeps panel and draft for retry', ok: true });
        } catch (error) {
            results.push({ name: 'panel close with save failure keeps panel and draft for retry', ok: false, error: String(error) });
        }
        await page.evaluate(() => { window.__noteFailActive = false; });
        await page.click('.reading-panel-close');
        await page.waitForTimeout(700);
        const afterRetry = await page.evaluate(async (phraseId) => {
            const rd = await import('/modules/reading-store.js');
            return {
                panelOpen: !document.getElementById('article-reading-panel')?.classList.contains('hidden'),
                stored: rd.getLearningItem(phraseId)?.note
            };
        }, ids.phraseId);
        try {
            assert.equal(afterRetry.panelOpen, false, JSON.stringify(afterRetry));
            assert.equal(afterRetry.stored, 'draft typed before closing', JSON.stringify(afterRetry));
            results.push({ name: 'retry after clearing failure saves draft and closes panel', ok: true });
        } catch (error) {
            results.push({ name: 'retry after clearing failure saves draft and closes panel', ok: false, error: String(error) });
        }

        // ── 2. 篩選隱藏的草稿在 JSON 匯出前仍會保存 ──────────────────────
        await page.click('#article-reading-records-btn');
        await page.waitForTimeout(350);
        await page.locator(`[data-item-id="${ids.sentenceId}"] [data-action="expand"]`).click();
        const sentenceArea = page.locator(`[data-note-id="${ids.sentenceId}"]`);
        await sentenceArea.fill('hidden draft must be saved');
        // 立即切到只顯示詞，讓句子 textarea 從 DOM 消失；500ms 延遲尚未觸發。
        await page.click('[data-filter="words"]');
        await page.waitForTimeout(60);
        await page.locator('.reading-tools > summary').click();
        const download = await exportReadingNote(page, { selector: '#reading-export-json', fullBackup: true });
        const tmp = path.join(os.tmpdir(), `bdc-draft-backup-${Date.now()}.json`);
        await download.saveAs(tmp);
        const hiddenResult = await page.evaluate(async (sentenceId) => {
            const rd = await import('/modules/reading-store.js');
            return { stored: rd.getLearningItem(sentenceId)?.note, textareaVisible: !!document.querySelector(`[data-note-id="${sentenceId}"]`) };
        }, ids.sentenceId);
        try {
            assert.equal(hiddenResult.textareaVisible, false, JSON.stringify(hiddenResult));
            assert.equal(hiddenResult.stored, 'hidden draft must be saved', JSON.stringify(hiddenResult));
            results.push({ name: 'JSON export flushes drafts hidden by the active filter', ok: true });
        } catch (error) {
            results.push({ name: 'JSON export flushes drafts hidden by the active filter', ok: false, error: String(error) });
        }
        fs.rmSync(tmp, { force: true });

        // ── 3. 短語面板保存失敗：不關閉、保留輸入，可重試 ────────────────
        await page.click('.reading-panel-close');
        await page.waitForTimeout(300);
        const noteBeforePhrase = await page.evaluate(async () => {
            const rd = await import('/modules/reading-store.js');
            const found = rd.listLearningItems('art_draft_reliability').find((item) => item.kind === 'phrase' && item.anchor?.quote === 'look forward to');
            return found?.note;
        });
        await page.locator('.interactive-word[data-word="look"]').first().click();
        await page.waitForTimeout(250);
        await openTooltipMore(page, '.btn-pick-phrase');
        await page.locator('#word-analysis-tooltip .btn-pick-phrase').click();
        await page.waitForTimeout(350);
        await page.locator('.phrase-token').nth(3).click();
        await page.evaluate(async () => {
            const actions = await import('/modules/reading-actions.js');
            window.__noteFailActive = true;
            actions.__setNoteSaveInterceptorForTests(async () => {
                if (window.__noteFailActive) return { ok: false, error: 'injected_save_failure' };
                return null;
            });
        });
        await page.click('#phrase-picker-note');
        await page.waitForTimeout(150);
        await page.fill('#phrase-picker-note-input', 'phrase draft before close');
        await page.locator('.phrase-picker-close').click();
        await page.waitForTimeout(500);
        const pickerFailed = await page.evaluate(async () => {
            const rd = await import('/modules/reading-store.js');
            const found = rd.listLearningItems('art_draft_reliability').find((item) => item.kind === 'phrase' && item.anchor?.quote === 'look forward to');
            return {
                sheetOpen: !document.getElementById('phrase-picker')?.classList.contains('hidden'),
                inputValue: document.getElementById('phrase-picker-note-input')?.value,
                stored: found?.note
            };
        });
        try {
            assert.equal(pickerFailed.sheetOpen, true, JSON.stringify(pickerFailed));
            assert.equal(pickerFailed.inputValue, 'phrase draft before close', JSON.stringify(pickerFailed));
            assert.equal(pickerFailed.stored, noteBeforePhrase, JSON.stringify(pickerFailed));
            results.push({ name: 'phrase picker close with save failure keeps sheet and draft', ok: true });
        } catch (error) {
            results.push({ name: 'phrase picker close with save failure keeps sheet and draft', ok: false, error: String(error) });
        }
        await page.evaluate(() => { window.__noteFailActive = false; });
        await page.locator('.phrase-picker-close').click();
        await page.waitForTimeout(700);
        const pickerRetry = await page.evaluate(async () => {
            const rd = await import('/modules/reading-store.js');
            const found = rd.listLearningItems('art_draft_reliability').find((item) => item.kind === 'phrase' && item.anchor?.quote === 'look forward to');
            return {
                sheetOpen: !document.getElementById('phrase-picker')?.classList.contains('hidden'),
                stored: found?.note
            };
        });
        try {
            assert.equal(pickerRetry.sheetOpen, false, JSON.stringify(pickerRetry));
            assert.equal(pickerRetry.stored, 'phrase draft before close', JSON.stringify(pickerRetry));
            results.push({ name: 'phrase picker retry saves draft and closes', ok: true });
        } catch (error) {
            results.push({ name: 'phrase picker retry saves draft and closes', ok: false, error: String(error) });
        }
        await context.close();
    } finally {
        await browser.close();
    }
    console.log(JSON.stringify(results, null, 2));
    process.exitCode = results.every((item) => item.ok) ? 0 : 1;
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
