/**
 * 原文版本一致性驗收（P1-T6）。
 *
 * 覆蓋：
 *   - 修改輸入框後出現「舊版分析」提示、舊譯文保留、重試停用
 *   - 朗讀改用最新輸入（不唸舊 DOM），舊高亮已清除
 *   - 助手使用最新輸入，訊息 contentVersion 與新文字一致
 *   - 匯入另一篇：舊分析立即清空、朗讀停止、重試隱藏
 *   - 重新分析後提示消失
 *   - zh-HK 的版本提示文案
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/article-version-consistency.cjs
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const mock = require('./helpers/article-mock.cjs');

const PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${PORT}/`;

const ARTICLE_A = 'The reading room opens at eight.\n\nVisitors sign the book at the door.';
const ARTICLE_A_EDITED = 'The reading room closes at eight.\n\nVisitors sign the book at the door.';
const ARTICLE_B = '# Imported Chapter\n\nThe imported chapter starts with a quiet morning.';

const { check, finish } = mock.createReporter('原文版本一致性');

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: mock.CHROME });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await mock.initScript(context);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error && error.message ? error.message : error)));

    let assistantPrompt = '';
    await mock.installProviderRoutes(page, async ({ route, request, body, prompt }) => {
        const isAssistant = Array.isArray(body?.messages) && body.messages.some((m) => String(m.role) === 'system');
        if (isAssistant || body?.stream === true) {
            assistantPrompt = prompt;
            return route.fulfill({
                status: 200,
                headers: { ...mock.CORS_HEADERS, 'Content-Type': 'text/event-stream' },
                body: `data: ${JSON.stringify({ choices: [{ delta: { content: '這是助手回答。' } }] })}\n\ndata: [DONE]\n\n`
            });
        }
        if (request.url().includes('/models')) return route.fulfill({ status: 200, headers: mock.CORS_HEADERS, body: '{}' });
        return mock.jsonReply(route, mock.translatedParagraphReply(prompt));
    });

    // 文章庫改成單篇假文章：走真正的匯入流程，不依賴 repo 內教材內容。
    await page.route('**/articles/manifest.json', (route) => route.fulfill({
        status: 200,
        headers: { ...mock.CORS_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify([{
            id: 'mock-import',
            title: 'Imported Chapter',
            description: 'For version tests',
            difficulty: 'test',
            category: 'test',
            path: 'articles/mock-import.json'
        }])
    }));
    await page.route('**/articles/mock-import.json', (route) => route.fulfill({
        status: 200,
        headers: { ...mock.CORS_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Imported Chapter', content: 'The imported chapter starts with a quiet morning.' })
    }));

    await page.goto(BASE + '#a', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    // 首次載入可能自動開一個 modal（登入／提示）；先關掉再操作文章區。
    await page.evaluate(() => {
        const modal = document.getElementById('app-modal');
        if (modal && !modal.classList.contains('hidden')) modal.querySelector('.modal-close-btn')?.click();
    });
    await page.waitForTimeout(200);

    const tInPage = (key, params) => page.evaluate(async ({ key, params }) => {
        const mod = await import('/modules/i18n.js');
        return mod.t(key, params);
    }, { key, params });
    const setInput = (text) => page.evaluate((value) => {
        const el = document.getElementById('article-input');
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
    const waitAnalyzeDone = () => page.waitForFunction(() => {
        const btn = document.getElementById('analyze-article-btn');
        return btn && !btn.disabled && !document.querySelector('#article-analysis-container .inline-progress');
    }, null, { timeout: 60000 });
    const noticeState = () => page.evaluate(() => {
        const notice = document.getElementById('article-version-notice');
        return {
            exists: !!notice,
            hidden: !notice || notice.classList.contains('hidden'),
            text: notice ? notice.textContent.replace(/\s+/g, ' ').trim() : ''
        };
    });
    const setLocale = (locale) => page.evaluate(async (loc) => {
        const mod = await import('/modules/i18n.js');
        mod.setLocale(loc);
    }, locale);
    const openAssistant = async () => {
        const hidden = await page.evaluate(() => document.getElementById('assistant-panel')?.classList.contains('assistant-hidden'));
        if (hidden) await page.click('#assistant-fab');
        await page.waitForTimeout(300);
    };

    // ── 分析 A ────────────────────────────────────────────────────────
    console.log('\n[情境 1] 分析原文');
    await setInput(ARTICLE_A);
    await page.click('#analyze-article-btn');
    await waitAnalyzeDone();
    await page.waitForTimeout(400);
    const analyzed = await page.evaluate(() => ({
        pairs: document.querySelectorAll('#article-analysis-container .paragraph-pair').length,
        chinese: Array.from(document.querySelectorAll('.paragraph-chinese')).map((el) => el.textContent.trim()).join(' '),
        statuses: Array.from(document.querySelectorAll('.para-status')).map((el) => el.dataset.status)
    }));
    check('分析完成並有譯文', analyzed.pairs >= 2 && /譯句/.test(analyzed.chinese), JSON.stringify(analyzed));
    check('版本提示預設隱藏', (await noticeState()).hidden, JSON.stringify(await noticeState()));

    // ── 修改原文：出現舊版提示，不清空譯文 ────────────────────────────
    console.log('\n[情境 2] 修改原文');
    await setInput(ARTICLE_A_EDITED);
    await page.waitForTimeout(600);
    const staleState = await page.evaluate(() => ({
        chinese: Array.from(document.querySelectorAll('.paragraph-chinese')).map((el) => el.textContent.trim()).join(' '),
        paragraphRetryDisabled: Array.from(document.querySelectorAll('.retry-paragraph-btn')).every((btn) => btn.disabled),
        batchDisabled: document.getElementById('retry-failed-paragraphs-btn').disabled,
        batchHidden: document.getElementById('retry-failed-paragraphs-btn').classList.contains('hidden')
    }));
    const staleNotice = await noticeState();
    check('修改後 600ms 內出現舊版提示', !staleNotice.hidden, JSON.stringify(staleNotice));
    check('提示說明畫面仍是舊版分析', staleNotice.text.includes(await tInPage('article.analysisStaleTitle')), staleNotice.text);
    check('舊譯文仍保留（不自動清空）', /譯句/.test(staleState.chinese), JSON.stringify(staleState));
    check('逐段重試已停用', staleState.paragraphRetryDisabled, JSON.stringify(staleState));
    check('批次重試已停用', staleState.batchHidden || staleState.batchDisabled, JSON.stringify(staleState));

    // ── 朗讀使用最新輸入 ──────────────────────────────────────────────
    console.log('\n[情境 3] 朗讀最新輸入');
    await page.click('#read-article-btn');
    await page.waitForTimeout(500);
    const staleHintText = await tInPage('article.analysisStaleHint');
    const reading = await page.evaluate(() => ({
        display: document.getElementById('current-sentence-display')?.textContent?.trim() || '',
        active: document.querySelectorAll('.sentence-active').length,
        toasts: Array.from(document.querySelectorAll('.message-toast__text')).map((el) => el.textContent.trim())
    }));
    check('朗讀使用修改後的文字', reading.display.includes('closes'), JSON.stringify(reading));
    check('朗讀不唸出舊版本的詞', !reading.display.includes('opens'), JSON.stringify(reading));
    check('舊版高亮已清除', reading.active === 0, JSON.stringify(reading));
    check('朗讀時提示使用最新輸入', reading.toasts.some((text) => text.includes(staleHintText)), JSON.stringify(reading.toasts));

    // ── 助手使用最新輸入 ──────────────────────────────────────────────
    console.log('\n[情境 4] 助手使用最新輸入');
    await page.click('#assistant-fab');
    await page.waitForTimeout(300);
    const chipBefore = await page.evaluate(() => document.getElementById('assistant-context-chip')?.textContent?.trim() || '');
    check('助手 context chip 標示尚未分析的新內容', chipBefore.includes(await tInPage('assistant.contextUnanalyzed')), chipBefore);
    await page.fill('#assistant-input', 'Q-版本測試');
    await page.click('#assistant-send');
    await page.waitForFunction(() => {
        const nodes = Array.from(document.querySelectorAll('#assistant-messages .assistant-assistant'));
        const el = nodes[nodes.length - 1];
        return !!el && el.textContent.includes('這是助手回答。');
    }, null, { timeout: 20000 });
    check('助手收到最新輸入的正文', assistantPrompt.includes('closes') && !assistantPrompt.includes('opens'), assistantPrompt.slice(0, 200));
    const stored = await page.evaluate(async () => {
        const store = await import('/modules/reading-store.js');
        const protocol = await import('/shared/reading-protocol.mjs');
        const input = document.getElementById('article-input').value;
        const expected = protocol.contentVersionOf(input);
        const conversations = store.listConversations();
        for (const conv of conversations) {
            const messages = await store.getMessages(conv.id);
            const hit = messages.find((m) => m.role === 'assistant' && String(m.content || '').includes('這是助手回答。'));
            if (hit) return { contentVersion: hit.contentVersion || '', expected };
        }
        return { contentVersion: '', expected };
    });
    check('助手訊息的 contentVersion 是最新輸入', !!stored.contentVersion && stored.contentVersion === stored.expected, JSON.stringify(stored));

    // ── 匯入另一篇：舊分析立即清空 ────────────────────────────────────
    console.log('\n[情境 5] 匯入另一篇');
    await page.click('#show-article-library-btn');
    await page.waitForTimeout(400);
    await page.click('.article-library-item');
    await page.waitForTimeout(700);
    const imported = await page.evaluate(async () => {
        const mod = await import('/modules/i18n.js');
        return {
            input: document.getElementById('article-input').value,
            containerText: document.getElementById('article-analysis-container').textContent.trim(),
            expectedNotice: mod.t('article.importReplacedAnalysis'),
            pairs: document.querySelectorAll('#article-analysis-container .paragraph-pair').length,
            batchHidden: document.getElementById('retry-failed-paragraphs-btn').classList.contains('hidden'),
            stopDisabled: document.getElementById('stop-read-article-btn').disabled,
            currentSentence: document.getElementById('current-sentence-display')?.textContent?.trim() || '',
            versionNoticeHidden: document.getElementById('article-version-notice').classList.contains('hidden')
        };
    });
    check('匯入後輸入框是新文章', imported.input.includes('Imported Chapter') && imported.input.includes('quiet morning'), JSON.stringify(imported.input));
    check('匯入後舊分析被清空', imported.pairs === 0 && imported.containerText.includes(imported.expectedNotice), JSON.stringify(imported));
    check('匯入後批次重試隱藏', imported.batchHidden === true, JSON.stringify(imported));
    check('匯入後朗讀已停止', imported.stopDisabled === true && imported.currentSentence === '', JSON.stringify(imported));
    check('匯入後版本提示隱藏', imported.versionNoticeHidden === true, JSON.stringify(imported));

    // ── 重新分析 B：提示消失 ──────────────────────────────────────────
    console.log('\n[情境 6] 重新分析後恢復');
    await page.click('#analyze-article-btn');
    await waitAnalyzeDone();
    await page.waitForTimeout(400);
    const reanalyzed = await page.evaluate(() => ({
        hidden: document.getElementById('article-version-notice').classList.contains('hidden'),
        pairs: document.querySelectorAll('#article-analysis-container .paragraph-pair').length,
        chip: document.getElementById('assistant-context-chip')?.textContent?.trim() || '',
        chipState: document.getElementById('assistant-context-chip')?.dataset?.state || ''
    }));
    check('重新分析後版本提示消失', reanalyzed.hidden === true, JSON.stringify(reanalyzed));
    check('重新分析後有新的譯文', reanalyzed.pairs >= 1, JSON.stringify(reanalyzed));
    check('助手 chip 改為已分析', reanalyzed.chipState === 'analyzed', JSON.stringify(reanalyzed));

    // ── zh-HK 的版本提示 ─────────────────────────────────────────────
    console.log('\n[情境 7] zh-HK 版本提示');
    await page.evaluate(async () => {
        const mod = await import('/modules/i18n.js');
        mod.setLocale('zh-HK');
    });
    await page.waitForTimeout(400);
    await setInput(`${imported.input}\n\nAnother edited line.`);
    await page.waitForTimeout(600);
    const hkNotice = await noticeState();
    const hkTitle = await tInPage('article.analysisStaleTitle');
    check('切到 zh-HK 後提示仍在', !hkNotice.hidden, JSON.stringify(hkNotice));
    check('zh-HK 提示文案為香港繁體', hkNotice.text.includes(hkTitle) && hkTitle.includes('畫面'), `${hkNotice.text} / ${hkTitle}`);

    // 切回 zh-CN：同一份狀態要重新套用簡體文案。
    await setLocale('zh-CN');
    await page.waitForTimeout(400);
    const cnNotice = await noticeState();
    const cnTitle = await tInPage('article.analysisStaleTitle');
    check('切回 zh-CN 後提示恢復簡體', !cnNotice.hidden && cnNotice.text.includes(cnTitle), `${cnNotice.text} / ${cnTitle}`);
    check('zh-CN／zh-HK 版本提示文案確實不同', cnTitle !== hkTitle, `${cnTitle} / ${hkTitle}`);

    // ── 未分析記錄：chip 不得標成 analyzed，版本提示要重設（P2-4） ──
    console.log('\n[情境 8] 切換到未分析記錄');
    await page.evaluate(async () => {
        const store = await import('/modules/article-store.js');
        await store.saveArticle({
            articleId: 'art_unanalyzed',
            article: 'UNANALYZED The quiet archive opens on Monday.\n\nNo analysis has been produced for this record.',
            result: null,
            title: 'Unanalyzed record',
            sourceType: 'paste'
        }, { touch: false });
    });
    await mock.openRecord(page, 'art_unanalyzed');
    const unanalyzed = await page.evaluate(() => ({
        input: document.getElementById('article-input').value,
        noticeHidden: document.getElementById('article-version-notice').classList.contains('hidden'),
        containerText: document.getElementById('article-analysis-container').textContent.trim(),
        pairs: document.querySelectorAll('#article-analysis-container .paragraph-pair').length,
        batchHidden: document.getElementById('retry-failed-paragraphs-btn').classList.contains('hidden')
    }));
    const notAnalyzedHint = await tInPage('article.historyNotAnalyzedHint');
    check('未分析記錄：畫面顯示尚未分析', unanalyzed.pairs === 0 && unanalyzed.containerText.includes(notAnalyzedHint), JSON.stringify(unanalyzed));
    check('未分析記錄：不與「舊版分析」提示同時出現', unanalyzed.noticeHidden === true, JSON.stringify(unanalyzed));
    check('未分析記錄：批次重試隱藏', unanalyzed.batchHidden === true, JSON.stringify(unanalyzed));
    await openAssistant();
    const chipUnanalyzed = await page.evaluate(async () => {
        const i18n = await import('/modules/i18n.js');
        const chip = document.getElementById('assistant-context-chip');
        return {
            text: chip?.textContent?.trim() || '',
            state: chip?.dataset?.state || '',
            expected: i18n.t('assistant.contextUnanalyzed')
        };
    });
    check('未分析記錄：助手 chip 標示尚未分析', chipUnanalyzed.state === 'unanalyzed', JSON.stringify(chipUnanalyzed));
    check('未分析記錄：助手 chip 不得標成 analyzed', chipUnanalyzed.state !== 'analyzed' && chipUnanalyzed.text.includes(chipUnanalyzed.expected), JSON.stringify(chipUnanalyzed));

    // ── zh-HK 動態 chip（含面板重建後不需再開一次） ──────────────
    console.log('\n[情境 9] zh-HK 助手 chip');
    await setLocale('zh-HK');
    await page.waitForTimeout(400);
    const chipHk = await page.evaluate(async () => {
        const i18n = await import('/modules/i18n.js');
        const chip = document.getElementById('assistant-context-chip');
        return {
            text: chip?.textContent?.trim() || '',
            state: chip?.dataset?.state || '',
            expected: i18n.t('assistant.contextUnanalyzed'),
            globalLabel: i18n.t('assistant.globalSession')
        };
    });
    check('zh-HK：面板重建後 chip 立即有內容', chipHk.text.length > 0, JSON.stringify(chipHk));
    check('zh-HK：chip 仍標示尚未分析', chipHk.state === 'unanalyzed' && chipHk.text.includes(chipHk.expected), JSON.stringify(chipHk));

    await page.evaluate(() => {
        const el = document.getElementById('article-input');
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(500);
    const chipGlobalHk = await page.evaluate(async () => {
        const i18n = await import('/modules/i18n.js');
        const chip = document.getElementById('assistant-context-chip');
        return { text: chip?.textContent?.trim() || '', expected: i18n.t('assistant.globalSession') };
    });
    check('zh-HK：無文章時 chip 為香港繁體', chipGlobalHk.text === chipGlobalHk.expected, `${chipGlobalHk.text} / ${chipGlobalHk.expected}`);

    await setLocale('zh-CN');
    await page.waitForTimeout(400);
    const chipGlobalCn = await page.evaluate(async () => {
        const i18n = await import('/modules/i18n.js');
        const chip = document.getElementById('assistant-context-chip');
        return { text: chip?.textContent?.trim() || '', expected: i18n.t('assistant.globalSession') };
    });
    check('切回 zh-CN：chip 恢復簡體', chipGlobalCn.text === chipGlobalCn.expected, `${chipGlobalCn.text} / ${chipGlobalCn.expected}`);
    check('zh-CN／zh-HK 全域 chip 文案不同', chipGlobalCn.expected !== chipGlobalHk.expected, `${chipGlobalCn.expected} / ${chipGlobalHk.expected}`);

    check('沒有未預期的頁面錯誤', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)));

    await browser.close();
    const failures = finish();
    if (failures) process.exit(1);
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
