/**
 * P3-T3：locale 切換保留草稿、焦點與面板狀態。
 *
 * 覆蓋：
 *   a. 助手輸入 10 字、游標置中，zh-CN→zh-HK→zh-CN：面板仍開、草稿與游標保留，
 *      resize／hashchange listener 不累積（以註冊次數斷言）
 *   b. 助手串流中切語言：半段以 cancelled 保存、不標成完整、重開會話仍在
 *   c. 閱讀面板開著、篩選「標記」、捲到中段切語言：面板／篩選／scroll 接近原值
 *   d. 片語筆記輸入中切語言：先保存、草稿不丢；mock 保存失敗時 sheet 不關並提示重試
 *   e. 單詞 tooltip 開著切語言：文字換新語言、焦點不在 body
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/locale-panel-state.cjs
 *
 * 不連真實 AI／TTS／金鑰：助手走本機 mock SSE 供應商，單詞詳解走已保存的
 * detailed_analysis；同步端點指向不存在的 127.0.0.1 測試位址。
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const mock = require('./helpers/article-mock.cjs');
const { createMockStreamServer } = require('./helpers/mock-stream-server.cjs');

const PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${PORT}/`;

const FIRST_SENTENCE = 'We look forward to meeting you.';
const LONG_SENTENCES = Array.from({ length: 24 }, (_, i) => `Reading line ${i + 1} keeps the panel list long enough to scroll.`);
const ARTICLE = {
    id: 'art_locale_state',
    title: 'Locale State',
    body: `${FIRST_SENTENCE}\n\n${LONG_SENTENCES.join(' ')}`,
    result: {
        chinese_translation: '我們期待與你見面。',
        word_alignment: [],
        detailed_analysis: [
            { word: 'look', sentence: FIRST_SENTENCE, analysis: { phonetic: 'lʊk', pos: 'v.', meaning: '看；期待', role: '動詞' } }
        ],
        paragraph_analysis: [
            { chinese_translation: '我們期待與你見面。', sentences: [{ en: FIRST_SENTENCE, zh: '我們期待與你見面。' }] },
            { chinese_translation: '閱讀列。', sentences: LONG_SENTENCES.map((en) => ({ en, zh: '' })) }
        ],
        sentence_analysis: [],
        phrase_analysis: []
    }
};

const { check, finish } = mock.createReporter('P3-T3 locale 切換保留狀態');

function assistantProfile(baseUrl) {
    const binding = {
        formatVersion: 1,
        format: 'gemini',
        apiUrl: `${baseUrl}/v1beta/models/%7Bmodel%7D:generateContent`,
        modelsUrl: `${baseUrl}/v1beta/models`,
        authMode: 'google'
    };
    return {
        schemaVersion: 1,
        providers: {
            mockgemini: {
                label: 'Mock Gemini',
                enabled: true,
                format: 'gemini',
                baseUrl,
                apiUrl: binding.apiUrl,
                modelsUrl: binding.modelsUrl,
                authMode: 'google',
                allowedModels: ['mock-model'],
                discoveredModels: [{ id: 'mock-model' }]
            }
        },
        credentials: {
            mockgemini: {
                apiKey: 'mock-key',
                binding,
                version: 0,
                syncMode: 'local-only'
            }
        },
        taskModels: { assistant: 'mockgemini:mock-model', default: 'mockgemini:mock-model' },
        defaultModel: 'mockgemini:mock-model'
    };
}

(async () => {
    const server = createMockStreamServer();
    const serverUrl = await server.listen();
    const streamState = server.state;

    const browser = await chromium.launch({ headless: true, executablePath: mock.CHROME });
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    // 先安裝 listener 計數器，才能證明反覆切語言不會累積 resize／hashchange listener。
    await context.addInitScript(() => {
        const counts = { resize: 0, hashchange: 0 };
        window.__bdcListenerCounts = counts;
        const original = window.addEventListener.bind(window);
        window.addEventListener = function addEventListener(type, listener, options) {
            if (type === 'resize' || type === 'hashchange') counts[type] += 1;
            return original(type, listener, options);
        };
    });
    await mock.initScript(context, { profile: assistantProfile(serverUrl) });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error && error.message ? error.message : error)));

    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
        const modal = document.getElementById('app-modal');
        if (modal && !modal.classList.contains('hidden')) modal.querySelector('.modal-close-btn')?.click();
    });
    await page.waitForTimeout(200);

    const tInPage = (key, params) => page.evaluate(async ({ key, params }) => {
        const mod = await import('/modules/i18n.js');
        return mod.t(key, params);
    }, { key, params });

    const setLocale = (locale) => page.evaluate(async (loc) => {
        const i18n = await import('/modules/i18n.js');
        return i18n.setLocale(loc);
    }, locale);

    const listenerCounts = () => page.evaluate(() => ({ ...(window.__bdcListenerCounts || {}) }));

    const waitFor = async (fn, timeout = 15000, label = '') => {
        try {
            await page.waitForFunction(fn, null, { timeout, polling: 100 });
            return true;
        } catch (_) {
            console.log(`  (等待逾時${label ? '：' + label : ''})`);
            return false;
        }
    };

    // ── 種資料並開啟文章（不經 AI）──────────────────────────────────
    const seeded = await page.evaluate(async (article) => {
        const art = await import('/modules/article-store.js');
        const rd = await import('/modules/reading-store.js');
        const st = await import('/modules/state.js');
        const { contentVersionOf } = await import('/shared/reading-protocol.mjs');
        await art.initArticleStore();
        await rd.initReadingStore();
        await art.saveArticle({
            articleId: article.id,
            article: article.body,
            title: article.title,
            sourceType: 'paste',
            result: article.result
        });
        st.setCurrentArticleId(article.id);
        const version = contentVersionOf(article.body);
        const ids = [];
        for (let i = 0; i < article.lines.length; i += 1) {
            const sentence = article.lines[i];
            const start = article.body.indexOf(sentence);
            const result = await rd.upsertLearningItem({
                articleId: article.id,
                contentVersion: version,
                kind: 'sentence',
                anchor: { start, end: start + sentence.length, quote: sentence },
                sentence,
                explanation: { language: 'zh-CN', result: { analysis: { meaning: `意思 ${i + 1}` } }, generatedAt: new Date().toISOString() },
                note: `note ${i + 1}`,
                marked: true
            }, { markViewed: true });
            if (result.ok) ids.push(result.entity.id);
        }
        return { ids, version };
    }, { ...ARTICLE, lines: LONG_SENTENCES });

    const navigateToArticle = async () => {
        if (!(await page.locator('#article-btn').isVisible().catch(() => false))) {
            await page.click('#nav-more-btn').catch(() => {});
            await page.waitForTimeout(150);
        }
        await page.click('#article-btn');
        await page.waitForTimeout(250);
    };
    await navigateToArticle();
    await page.evaluate(async (id) => {
        const state = await import('/modules/state.js');
        const article = await import('/features/article/article.js');
        state.setCurrentArticleId(id);
        await article.showCurrentArticleIfAvailable();
    }, ARTICLE.id);
    await page.waitForFunction(() => document.querySelectorAll('.interactive-word[data-word="look"]').length >= 1, null, { timeout: 5000 });
    await page.waitForTimeout(200);

    const openAssistant = async () => {
        const hidden = await page.evaluate(() => {
            const panel = document.getElementById('assistant-panel');
            return !panel || panel.classList.contains('assistant-hidden');
        });
        if (hidden) await page.click('#assistant-fab');
        await page.waitForSelector('#assistant-panel:not(.assistant-hidden)', { timeout: 5000 });
        await page.waitForTimeout(250);
    };
    const newAssistantSession = async () => {
        await openAssistant();
        await page.click('#assistant-new');
        await page.waitForTimeout(350);
    };

    // ════════════════════════════════════════════════════════════════
    // a. 助手草稿、游標與 listener 不累積
    // ════════════════════════════════════════════════════════════════
    console.log('\n[a] 助手草稿與游標');
    await newAssistantSession();
    const DRAFT = 'ABCDEFGHIJ'; // 10 字
    await page.evaluate((draft) => {
        const input = document.getElementById('assistant-input');
        input.focus();
        input.value = draft;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.setSelectionRange(4, 4);
    }, DRAFT);
    const caretBefore = await page.evaluate(() => document.getElementById('assistant-input').selectionStart);
    check('草稿輸入後游標在位置 4', caretBefore === 4, String(caretBefore));

    const countsBefore = await listenerCounts();
    await setLocale('zh-HK');
    const draftHint = await tInPage('assistant.localeKeptDraft');
    const afterFirst = await page.waitForFunction((hint) => {
        const panel = document.getElementById('assistant-panel');
        const input = panel?.querySelector('#assistant-input');
        return !!panel && !panel.classList.contains('assistant-hidden')
            && input?.value === 'ABCDEFGHIJ'
            && Array.from(panel.querySelectorAll('.assistant-hint')).some((el) => el.textContent.includes(hint));
    }, draftHint, { timeout: 8000, polling: 100 }).then(() => true).catch(() => false);
    const firstSwitch = await page.evaluate(() => {
        const panel = document.getElementById('assistant-panel');
        const input = panel?.querySelector('#assistant-input');
        return {
            open: !!panel && !panel.classList.contains('assistant-hidden'),
            value: input?.value || '',
            selectionStart: input ? input.selectionStart : -1,
            hints: Array.from(panel.querySelectorAll('.assistant-hint')).map((el) => el.textContent.trim())
        };
    });
    check('切 zh-HK 後助手面板仍開', afterFirst === true && firstSwitch.open === true, JSON.stringify(firstSwitch));
    check('切 zh-HK 後草稿完整保留', firstSwitch.value === DRAFT, JSON.stringify(firstSwitch.value));
    check('切 zh-HK 後游標位置不變', firstSwitch.selectionStart === 4, String(firstSwitch.selectionStart));
    check('草稿非空時提示保留草稿（只一次）', firstSwitch.hints.filter((text) => text.includes(draftHint)).length === 1, JSON.stringify(firstSwitch.hints));

    const countsAfterFirst = await listenerCounts();
    await setLocale('zh-CN');
    const afterSecond = await waitFor(() => {
        const panel = document.getElementById('assistant-panel');
        const input = panel?.querySelector('#assistant-input');
        return !!panel && !panel.classList.contains('assistant-hidden') && input?.value === 'ABCDEFGHIJ';
    }, 8000, 'zh-CN restore');
    const secondSwitch = await page.evaluate(() => {
        const panel = document.getElementById('assistant-panel');
        const input = panel?.querySelector('#assistant-input');
        return {
            open: !!panel && !panel.classList.contains('assistant-hidden'),
            value: input?.value || '',
            selectionStart: input ? input.selectionStart : -1,
            hints: Array.from(panel.querySelectorAll('.assistant-hint')).map((el) => el.textContent.trim())
        };
    });
    const countsAfterSecond = await listenerCounts();
    const draftHintCn = await tInPage('assistant.localeKeptDraft');
    check('切回 zh-CN 後草稿與游標仍保留', afterSecond === true && secondSwitch.value === DRAFT && secondSwitch.selectionStart === 4, JSON.stringify(secondSwitch));
    check('每次切換只提示一次（面板重建後不累積）', secondSwitch.hints.filter((text) => text.includes(draftHintCn)).length === 1, JSON.stringify(secondSwitch.hints));

    // 快速連切：第一次 restore 尚未完成就切第二次，第二次 capture 讀到的是重建中的空面板；
    // 必須沿用待 restore 的快照，不能把草稿／游標丟掉或把面板收起來。
    await setLocale('zh-HK');
    await setLocale('zh-CN');
    const rapidOk = await waitFor(() => {
        const panel = document.getElementById('assistant-panel');
        const input = panel?.querySelector('#assistant-input');
        return !!panel && !panel.classList.contains('assistant-hidden')
            && input?.value === 'ABCDEFGHIJ' && input.selectionStart === 4;
    }, 8000, 'rapid locale switch restore');
    const rapidState = await page.evaluate(() => {
        const panel = document.getElementById('assistant-panel');
        const input = panel?.querySelector('#assistant-input');
        return {
            open: !!panel && !panel.classList.contains('assistant-hidden'),
            value: input?.value || '',
            selectionStart: input ? input.selectionStart : -1
        };
    });
    check('快速連切兩次後草稿、游標與面板仍保留', rapidOk === true && rapidState.open === true
        && rapidState.value === DRAFT && rapidState.selectionStart === 4, JSON.stringify(rapidState));
    const resizeDelta1 = countsAfterFirst.resize - countsBefore.resize;
    const resizeDelta2 = countsAfterSecond.resize - countsAfterFirst.resize;
    const hashDelta1 = countsAfterFirst.hashchange - countsBefore.hashchange;
    const hashDelta2 = countsAfterSecond.hashchange - countsAfterFirst.hashchange;
    check('resize listener 每次切換固定數量、不累積', resizeDelta1 > 0 && resizeDelta1 === resizeDelta2, JSON.stringify({ resizeDelta1, resizeDelta2, countsBefore, countsAfterFirst, countsAfterSecond }));
    check('hashchange listener 每次切換固定數量、不累積', hashDelta1 > 0 && hashDelta1 === hashDelta2, JSON.stringify({ hashDelta1, hashDelta2 }));
    // 面板不抖動：一次 hashchange 只會讓狀態收斂一次，不會把開著的面板關掉。
    await page.evaluate(() => window.dispatchEvent(new HashChangeEvent('hashchange')));
    await page.waitForTimeout(120);
    const afterHash = await page.evaluate(() => !document.getElementById('assistant-panel')?.classList.contains('assistant-hidden'));
    check('觸發 hashchange 不會把面板抖掉', afterHash === true, String(afterHash));
    await page.evaluate(() => { const input = document.getElementById('assistant-input'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); });

    // ════════════════════════════════════════════════════════════════
    // b. 助手串流中切語言
    // ════════════════════════════════════════════════════════════════
    console.log('\n[b] 串流中切語言');
    await newAssistantSession();
    streamState.mode = 'slow';
    streamState.chunkDelayMs = 140;
    streamState.chunks = [
        '串流半段內容第一句，切語言時必須保留。',
        '串流半段內容第二句，不應被標成完整回答。',
        '串流半段內容第三句。',
        '串流半段內容第四句。'
    ];
    const QUESTION = 'Q-LOCALE-串流中切換語言';
    await page.fill('#assistant-input', QUESTION);
    await page.click('#assistant-send');
    await waitFor(() => !!document.querySelector('.assistant-stop'), 15000, 'stream start');
    await page.waitForTimeout(260);
    const convBefore = await page.evaluate(async () => {
        const rd = await import('/modules/reading-store.js');
        return rd.listConversations()[0]?.id || '';
    });
    await setLocale('zh-HK');
    await waitFor(() => !!document.querySelector('#assistant-panel .assistant-cancelled'), 15000, 'cancelled restored');
    const cancelledLabel = await tInPage('assistant.streamCancelled');
    const streamingResult = await page.evaluate(async ({ convId }) => {
        const rd = await import('/modules/reading-store.js');
        const messages = convId ? await rd.getMessages(convId) : [];
        const assistant = messages.filter((m) => m.role === 'assistant');
        const last = assistant[assistant.length - 1] || null;
        const panel = document.getElementById('assistant-panel');
        const nodes = Array.from(panel?.querySelectorAll('.assistant-assistant') || []);
        const lastNode = nodes[nodes.length - 1] || null;
        return {
            open: !!panel && !panel.classList.contains('assistant-hidden'),
            convId,
            status: last?.status || '',
            content: last?.content || '',
            cancelledNote: lastNode?.querySelector('.assistant-cancelled')?.textContent?.trim() || '',
            renderedText: lastNode?.textContent || '',
            input: panel?.querySelector('#assistant-input')?.value || '',
            conversations: rd.listConversations().length
        };
    }, { convId: convBefore });
    check('切語言後助手面板仍開', streamingResult.open === true, JSON.stringify(streamingResult.open));
    check('半段回答以 cancelled 保存，不是完整回答', streamingResult.status === 'cancelled', JSON.stringify(streamingResult.status));
    check('半段內容有保留', String(streamingResult.content).includes('串流半段內容第一句'), JSON.stringify(String(streamingResult.content).slice(0, 60)));
    check('重開會話仍看得到半段並標示已停止', streamingResult.renderedText.includes('串流半段內容第一句') && streamingResult.cancelledNote === cancelledLabel, JSON.stringify({ text: streamingResult.renderedText.slice(0, 60), note: streamingResult.cancelledNote }));
    check('原會話沒有被換掉', streamingResult.convId === convBefore, JSON.stringify({ before: convBefore, after: streamingResult.convId }));
    check('中止後原問題回到輸入框（可重試）', streamingResult.input === QUESTION, JSON.stringify(streamingResult.input));
    // 再切一次：取消訊息不應變成完整回答。
    await setLocale('zh-CN');
    await waitFor(() => !!document.querySelector('#assistant-panel .assistant-cancelled'), 15000, 'cancelled after second switch');
    const statusAfterSecondSwitch = await page.evaluate(async ({ convId }) => {
        const rd = await import('/modules/reading-store.js');
        const messages = await rd.getMessages(convId);
        const assistant = messages.filter((m) => m.role === 'assistant');
        return assistant[assistant.length - 1]?.status || '';
    }, { convId: convBefore });
    check('再切一次語言，cancelled 不會被標成完整', statusAfterSecondSwitch === 'cancelled', JSON.stringify(statusAfterSecondSwitch));
    await page.evaluate(() => { const input = document.getElementById('assistant-input'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); });

    // ════════════════════════════════════════════════════════════════
    // c. 閱讀面板：篩選、scroll、草稿
    // ════════════════════════════════════════════════════════════════
    console.log('\n[c] 閱讀面板狀態');
    await page.evaluate(() => document.getElementById('article-reading-records-btn')?.click());
    await page.waitForSelector('#article-reading-panel:not(.hidden)', { timeout: 5000 });
    await page.waitForTimeout(400);
    await page.click('#reading-panel-filters [data-filter="marked"]');
    await page.waitForTimeout(300);
    const scrollBefore = await page.evaluate(() => {
        const list = document.querySelector('#reading-panel-list');
        list.scrollTop = Math.floor((list.scrollHeight - list.clientHeight) / 2);
        return { scrollTop: list.scrollTop, scrollHeight: list.scrollHeight, clientHeight: list.clientHeight };
    });
    check('面板清單可捲動且已捲到中段', scrollBefore.scrollTop > 100 && scrollBefore.scrollHeight > scrollBefore.clientHeight + 200, JSON.stringify(scrollBefore));

    // 筆記草稿：不按失焦、也不等 debounce，直接切語言。
    const NOTE_TEXT = '面板草稿-切語言不可丢';
    await page.fill(`[data-note-id="${seeded.ids[0]}"]`, NOTE_TEXT);
    await page.evaluate((noteId) => {
        const area = document.querySelector(`[data-note-id="${noteId}"]`);
        area.focus();
        area.setSelectionRange(2, 6);
    }, seeded.ids[0]);
    const focusedNoteId = await page.evaluate(() => document.activeElement?.getAttribute('data-note-id') || '');
    check('筆記輸入框取得焦點', focusedNoteId === seeded.ids[0], JSON.stringify(focusedNoteId));
    // page.fill 會把目標捲進視窗，捲動位置因此變了；再捲回中段後才切語言。
    const expectedScroll = await page.evaluate(() => {
        const list = document.querySelector('#reading-panel-list');
        list.scrollTop = Math.floor((list.scrollHeight - list.clientHeight) / 2);
        return list.scrollTop;
    });
    check('切換前清單位於中段', expectedScroll > 100, String(expectedScroll));

    await setLocale('zh-HK');
    // 提示文字會跟著新語言走，用目前 locale 的 t() 比對，避免寫死語言。
    const keptPanelToast = page.waitForFunction(async () => {
        const { t } = await import('/modules/i18n.js');
        const expected = t('article.localeKeptPanel');
        return Array.from(document.querySelectorAll('#message-container .message-toast__text'))
            .some((el) => el.textContent.includes(expected));
    }, null, { timeout: 8000, polling: 100 }).then(() => true).catch(() => false);
    await waitFor(() => {
        const element = document.getElementById('article-reading-panel');
        return !!element && !element.classList.contains('hidden')
            && element.querySelector('#reading-panel-filters .reading-filter.is-active')?.dataset.filter === 'marked';
    }, 10000, 'panel restore');
    await page.waitForTimeout(300);
    const panelAfter = await page.evaluate((noteId) => {
        const element = document.getElementById('article-reading-panel');
        const list = element?.querySelector('#reading-panel-list');
        const active = element?.querySelector('#reading-panel-filters .reading-filter.is-active');
        const savedBox = element?.querySelector('#reading-saved-only');
        return {
            open: !!element && !element.classList.contains('hidden'),
            bodyOpen: document.body.classList.contains('reading-panel-open'),
            filter: active?.dataset.filter || '',
            savedBoxExists: !!savedBox,
            savedOnly: !!savedBox?.checked,
            scrollTop: list ? list.scrollTop : -1,
            noteValue: element?.querySelector(`[data-note-id="${noteId}"]`)?.value ?? null,
            noteSelectionStart: element?.querySelector(`[data-note-id="${noteId}"]`)?.selectionStart ?? -1,
            noteSelectionEnd: element?.querySelector(`[data-note-id="${noteId}"]`)?.selectionEnd ?? -1,
            focusedNote: document.activeElement?.getAttribute?.('data-note-id') || ''
        };
    }, seeded.ids[0]);
    check('切語言後閱讀面板仍開', panelAfter.open === true && panelAfter.bodyOpen === true, JSON.stringify(panelAfter));
    check('篩選仍為「標記」', panelAfter.filter === 'marked', JSON.stringify(panelAfter.filter));
    check('savedOnly 篩選控制仍在且未勾選', panelAfter.savedBoxExists === true && panelAfter.savedOnly === false, JSON.stringify(panelAfter));
    check('scrollTop 接近原位置', Math.abs(panelAfter.scrollTop - expectedScroll) <= 40, JSON.stringify({ before: expectedScroll, after: panelAfter.scrollTop }));
    check('未保存的筆記草稿仍在輸入框', panelAfter.noteValue === NOTE_TEXT, JSON.stringify(panelAfter.noteValue));
    check('焦點回到原本的筆記輸入框', panelAfter.focusedNote === seeded.ids[0], JSON.stringify(panelAfter.focusedNote));
    check('筆記輸入框的游標／選取範圍保留', panelAfter.noteSelectionStart === 2 && panelAfter.noteSelectionEnd === 6,
        JSON.stringify({ start: panelAfter.noteSelectionStart, end: panelAfter.noteSelectionEnd }));
    check('面板恢復後有提示', (await keptPanelToast) === true, 'article.localeKeptPanel');

    // savedOnly 也要保留：勾選後切語言，checkbox 仍為勾選。
    await page.click('#reading-saved-only');
    await page.waitForTimeout(150);
    await setLocale('zh-CN');
    await waitFor(() => {
        const element = document.getElementById('article-reading-panel');
        return !!element && !element.classList.contains('hidden')
            && element.querySelector('#reading-saved-only')?.checked === true;
    }, 10000, 'savedOnly restore');
    const savedOnlyAfter = await page.evaluate(() => {
        const element = document.getElementById('article-reading-panel');
        const active = element?.querySelector('#reading-panel-filters .reading-filter.is-active');
        return {
            filter: active?.dataset.filter || '',
            savedOnly: !!element?.querySelector('#reading-saved-only')?.checked
        };
    });
    check('savedOnly 勾選狀態也保留', savedOnlyAfter.savedOnly === true && savedOnlyAfter.filter === 'marked', JSON.stringify(savedOnlyAfter));
    // 收尾：取消 savedOnly 並保存筆記草稿，避免影響後續情境。
    await page.evaluate(() => document.getElementById('article-reading-panel')?.querySelector('.reading-panel-close')?.click());
    await page.waitForTimeout(800);

    // ════════════════════════════════════════════════════════════════
    // d. 片語筆記輸入中切語言
    // ════════════════════════════════════════════════════════════════
    console.log('\n[d] 片語筆記');
    const openPicker = () => page.evaluate(async ({ articleId, sentence }) => {
        const picker = await import('/features/article/phrase-picker.js');
        return picker.openPhrasePicker({ articleId, sentence, context: '', startWord: 'look' });
    }, { articleId: ARTICLE.id, sentence: FIRST_SENTENCE });
    check('短語面板可開啟', await openPicker() === true, '');
    await page.waitForTimeout(350);
    // startWord=look 已選了起詞；再點一個 token 完成範圍（再點下一個會重新開始選取）。
    await page.locator('.phrase-token').nth(2).click();
    await page.click('#phrase-picker-note');
    await page.waitForTimeout(250);
    const PHRASE_NOTE = '片語草稿-切語言先保存';
    await page.fill('#phrase-picker-note-input', PHRASE_NOTE);
    await page.evaluate(() => {
        const input = document.getElementById('phrase-picker-note-input');
        input.focus();
        input.setSelectionRange(2, 6);
    });
    const phraseSelectionBefore = await page.evaluate(() => Array.from(document.querySelectorAll('.phrase-token.is-selected')).map((el) => el.getAttribute('data-index')));
    await setLocale('zh-HK');
    await waitFor(() => {
        const element = document.getElementById('phrase-picker');
        return !!element && !element.classList.contains('hidden');
    }, 10000, 'phrase picker restore');
    await page.waitForTimeout(400);
    const phraseAfter = await page.evaluate(async ({ articleId }) => {
        const rd = await import('/modules/reading-store.js');
        const item = rd.listLearningItems(articleId).find((entry) => entry.kind === 'phrase' || entry.kind === 'word');
        const stored = rd.listLearningItems(articleId)
            .map((entry) => String(entry.note || ''))
            .filter(Boolean);
        const element = document.getElementById('phrase-picker');
        return {
            open: !!element && !element.classList.contains('hidden'),
            selection: Array.from(element?.querySelectorAll('.phrase-token.is-selected') || []).map((el) => el.getAttribute('data-index')),
            noteValue: element?.querySelector('#phrase-picker-note-input')?.value ?? null,
            noteSelectionStart: element?.querySelector('#phrase-picker-note-input')?.selectionStart ?? -1,
            noteSelectionEnd: element?.querySelector('#phrase-picker-note-input')?.selectionEnd ?? -1,
            noteStored: stored.includes('片語草稿-切語言先保存'),
            firstItem: item?.note || ''
        };
    }, { articleId: ARTICLE.id });
    check('切語言後短語面板仍開', phraseAfter.open === true, JSON.stringify(phraseAfter.open));
    check('切語言前先保存筆記', phraseAfter.noteStored === true, JSON.stringify(phraseAfter.firstItem));
    check('短語選取範圍保留', JSON.stringify(phraseAfter.selection) === JSON.stringify(phraseSelectionBefore), JSON.stringify({ before: phraseSelectionBefore, after: phraseAfter.selection }));
    check('筆記輸入內容保留', phraseAfter.noteValue === PHRASE_NOTE, JSON.stringify(phraseAfter.noteValue));
    check('片語筆記的游標／選取範圍保留', phraseAfter.noteSelectionStart === 2 && phraseAfter.noteSelectionEnd === 6,
        JSON.stringify({ start: phraseAfter.noteSelectionStart, end: phraseAfter.noteSelectionEnd }));

    // 保存失敗：sheet 不關、顯示重試、草稿留在輸入框。
    await page.evaluate(async () => {
        const actions = await import('/modules/reading-actions.js');
        window.__localeNoteFail = true;
        actions.__setNoteSaveInterceptorForTests(async () => {
            if (window.__localeNoteFail) return { ok: false, error: 'injected_save_failure' };
            return null;
        });
    });
    const FAIL_NOTE = '片語草稿-保存失敗仍保留';
    await page.fill('#phrase-picker-note-input', FAIL_NOTE);
    await setLocale('zh-CN');
    const noteSaveFailedLabel = await tInPage('article.saveFailedRetry');
    await page.waitForTimeout(700);
    const phraseFailed = await page.evaluate(() => {
        const element = document.getElementById('phrase-picker');
        return {
            exists: !!element,
            open: !!element && !element.classList.contains('hidden'),
            status: element?.querySelector('#phrase-picker-status')?.textContent?.trim() || '',
            noteStatus: element?.querySelector('#phrase-picker-note-status')?.textContent?.trim() || '',
            noteValue: element?.querySelector('#phrase-picker-note-input')?.value ?? null
        };
    });
    check('保存失敗時 sheet 不關閉', phraseFailed.exists === true && phraseFailed.open === true, JSON.stringify(phraseFailed));
    check('保存失敗時顯示重試提示', phraseFailed.status === noteSaveFailedLabel || phraseFailed.noteStatus === noteSaveFailedLabel, JSON.stringify(phraseFailed));
    check('保存失敗時草稿留在輸入框', phraseFailed.noteValue === FAIL_NOTE, JSON.stringify(phraseFailed.noteValue));
    // 清掉注入的失敗後可正常保存並關閉。
    await page.evaluate(() => { window.__localeNoteFail = false; });
    await page.evaluate(() => { const input = document.getElementById('phrase-picker-note-input'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.click('.phrase-picker-close');
    await page.waitForTimeout(700);
    const phraseClosed = await page.evaluate(async ({ articleId }) => {
        const rd = await import('/modules/reading-store.js');
        const element = document.getElementById('phrase-picker');
        return {
            open: !!element && !element.classList.contains('hidden'),
            stored: rd.listLearningItems(articleId).some((entry) => String(entry.note || '') === '片語草稿-保存失敗仍保留')
        };
    }, { articleId: ARTICLE.id });
    check('清掉失敗後可保存並關閉', phraseClosed.open === false && phraseClosed.stored === true, JSON.stringify(phraseClosed));

    // ════════════════════════════════════════════════════════════════
    // e. tooltip 開著切語言
    // ════════════════════════════════════════════════════════════════
    console.log('\n[e] tooltip 語言');
    await page.locator('.interactive-word[data-word="look"]').first().click();
    await page.waitForSelector('#word-analysis-tooltip', { state: 'visible', timeout: 5000 });
    await page.waitForTimeout(200);
    const tooltipBefore = await page.evaluate(() => ({
        closeLabel: document.querySelector('#word-analysis-tooltip .tooltip-close')?.getAttribute('aria-label') || '',
        text: document.querySelector('#word-analysis-tooltip')?.textContent || ''
    }));
    const closeCn = await tInPage('article.close');
    check('tooltip 以目前語言顯示關閉按鈕', tooltipBefore.closeLabel === closeCn, JSON.stringify(tooltipBefore.closeLabel));
    await setLocale('zh-HK');
    await page.waitForTimeout(400);
    const closeHk = await tInPage('article.close');
    const tooltipAfter = await page.evaluate(() => {
        const tooltip = document.getElementById('word-analysis-tooltip');
        const active = document.activeElement;
        return {
            visible: !!tooltip && tooltip.style.display === 'block',
            closeLabel: tooltip?.querySelector('.tooltip-close')?.getAttribute('aria-label') || '',
            text: tooltip?.textContent || '',
            activeId: active?.id || '',
            activeTag: active?.tagName || '',
            activeInTooltip: !!tooltip && tooltip.contains(active)
        };
    });
    check('切語言後 tooltip 仍可見且文字換新語言', tooltipAfter.visible === true && tooltipAfter.closeLabel === closeHk && closeHk !== closeCn, JSON.stringify({ closeLabel: tooltipAfter.closeLabel, closeHk, closeCn }));
    check('切語言後詳解內容仍在', tooltipAfter.text.includes('看；期待'), JSON.stringify(tooltipAfter.text.slice(0, 60)));
    check('切語言後焦點不在 body', tooltipAfter.activeTag !== 'BODY' && tooltipAfter.activeId !== '' && tooltipAfter.activeInTooltip === true, JSON.stringify({ id: tooltipAfter.activeId, tag: tooltipAfter.activeTag, inTooltip: tooltipAfter.activeInTooltip }));

    check('沒有未預期的頁面錯誤', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)));

    await context.close();
    await browser.close();
    await server.close();
    const failures = finish();
    if (failures) process.exit(1);
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
