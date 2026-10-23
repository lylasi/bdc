/**
 * 助手狀態機驗收（P0-T1 載具；P1-T5 之後必須全綠）。
 *
 * 覆蓋：串流中斷、停止、錯誤後重試（含切換文章後重試）、連續提問。
 * 「串流中向上閱讀不被拉回」屬 P2-T4，未實作前以 PHASE2=1 才執行。
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/assistant-state.cjs
 *   PHASE2=1 PORT=8313 PLAYWRIGHT_MODULE=<...> node tests/assistant-state.cjs
 *
 * 供應商是本機 127.0.0.1 的 mock SSE 服務；不連外網、不需要金鑰。
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const mock = require('./helpers/article-mock.cjs');
const { createMockStreamServer } = require('./helpers/mock-stream-server.cjs');

const PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${PORT}/`;
const PHASE2 = process.env.PHASE2 === '1';

const ARTICLE_A = 'ALPHA-ARTICLE The reading room opens at eight. Visitors sign the book at the door.';
const ARTICLE_B = 'BETA-ARTICLE A different library closes early. The shelves are empty after lunch.';

const { check, finish } = mock.createReporter('助手狀態機');

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
        taskModels: {
            assistant: 'mockgemini:mock-model',
            default: 'mockgemini:mock-model'
        },
        defaultModel: 'mockgemini:mock-model'
    };
}

(async () => {
    const server = createMockStreamServer();
    const serverUrl = await server.listen();
    const state = server.state;

    const browser = await chromium.launch({ headless: true, executablePath: mock.CHROME });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await mock.initScript(context, { profile: assistantProfile(serverUrl) });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error && error.message ? error.message : error)));

    await page.goto(BASE + '#a', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    const tInPage = (key, params) => page.evaluate(async ({ key, params }) => {
        const mod = await import('/modules/i18n.js');
        return mod.t(key, params);
    }, { key, params });

    const setArticle = (text) => page.evaluate((value) => {
        const el = document.getElementById('article-input');
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);

    const openPanel = async () => {
        const hidden = await page.evaluate(() => document.getElementById('assistant-panel')?.classList.contains('assistant-hidden'));
        if (hidden) await page.click('#assistant-fab');
        await page.waitForTimeout(250);
    };
    const newSession = async () => {
        await openPanel();
        await page.click('#assistant-new');
        await page.waitForTimeout(300);
    };
    const sendText = async (text) => {
        await page.fill('#assistant-input', text);
        await page.click('#assistant-send');
    };
    const lastAssistant = () => page.evaluate(() => {
        const nodes = Array.from(document.querySelectorAll('#assistant-messages .assistant-assistant'));
        const el = nodes[nodes.length - 1];
        if (!el) return null;
        return {
            text: el.textContent || '',
            html: el.innerHTML,
            error: el.querySelector('.assistant-error')?.textContent?.trim() || '',
            cancelled: el.querySelector('.assistant-cancelled')?.textContent?.trim() || '',
            keepDoc: !!el.querySelector('.assistant-keep-doc'),
            retry: el.querySelector('.assistant-retry')?.textContent?.trim() || ''
        };
    });
    const userMessages = () => page.evaluate(() => Array.from(
        document.querySelectorAll('#assistant-messages .assistant-user')
    ).map((el) => el.textContent.trim()));
    // 找出含指定標記的助手訊息（跨所有會話），避免依賴會話排序。
    const findAssistantMessage = (marker) => page.evaluate(async (needle) => {
        const mod = await import('/modules/reading-store.js');
        const conversations = mod.listConversations();
        for (const conv of conversations) {
            const messages = await mod.getMessages(conv.id);
            const hit = messages.find((m) => m.role === 'assistant' && String(m.content || '').includes(needle));
            if (hit) return { conversationId: conv.id, status: hit.status || '', content: hit.content || '' };
        }
        return null;
    }, marker);
    const waitFor = async (fn, timeout = 20000, label = '') => {
        try {
            await page.waitForFunction(fn, null, { timeout, polling: 100 });
            return true;
        } catch (_) {
            console.log(`  (等待逾時${label ? '：' + label : ''})`);
            return false;
        }
    };

    // ── 情境 1：串流中斷，錯誤要在 finally 之後仍看得見 ────────────────
    console.log('\n[情境 1] 串流中斷');
    await setArticle(ARTICLE_A);
    await newSession();
    state.mode = 'errorEvent';
    state.chunks = ['這是一段已經收到的回答內容。'];
    const Q1 = 'Q1-請解釋第一句';
    await sendText(Q1);
    await waitFor(() => !!document.querySelector('#assistant-messages .assistant-retry'), 15000, 'retry');
    const errored = await lastAssistant();
    check('錯誤後保留已收到的內容', !!errored && errored.text.includes('這是一段已經收到的回答內容'), JSON.stringify(errored && errored.text));
    check('錯誤提示在 finally 之後仍可見', !!errored && !!errored.error, JSON.stringify(errored && errored.error));
    const retryOriginalLabel = await tInPage('assistant.retryOriginal');
    check('重試按鈕說明重試原本問題', !!errored && errored.retry === retryOriginalLabel, `${JSON.stringify(errored && errored.retry)} / ${retryOriginalLabel}`);

    // ── 情境 2：切到另一篇再重試，仍用原請求快照 ──────────────────────
    console.log('\n[情境 2] 切換文章後重試');
    await setArticle(ARTICLE_B);
    state.mode = 'ok';
    state.chunks = ['這是重試後的成功回答。'];
    const requestsBeforeRetry = state.requests.length;
    await page.click('#assistant-messages .assistant-retry');
    const retried = await waitFor(() => {
        const nodes = Array.from(document.querySelectorAll('#assistant-messages .assistant-assistant'));
        const el = nodes[nodes.length - 1];
        return !!el && el.textContent.includes('這是重試後的成功回答。');
    }, 20000, 'retry success');
    check('重試後得到完整回答', retried, '');
    const retryRequest = state.requests.slice(requestsBeforeRetry).find((item) => item.url.includes('streamGenerateContent'));
    const retryText = JSON.stringify(retryRequest?.body || {});
    check('重試仍使用原文章 A 的正文', retryText.includes('ALPHA-ARTICLE'), retryText.slice(0, 200));
    check('重試不會偷換成文章 B 的正文', !retryText.includes('BETA-ARTICLE'), retryText.slice(0, 200));
    const userTexts = await userMessages();
    check('原問題只出現一次', userTexts.filter((text) => text.includes(Q1)).length === 1, JSON.stringify(userTexts));
    const q1InRequest = (retryText.match(/Q1-請解釋第一句/g) || []).length;
    check('請求中的原問題不重複', q1InRequest === 1, String(q1InRequest));

    // ── 情境 3：停止不得存成完整回答 ─────────────────────────────────
    console.log('\n[情境 3] 使用者停止');
    await newSession();
    state.mode = 'slow';
    state.chunkDelayMs = 120;
    state.chunks = [
        '第一段慢速回答內容，用來確認停止行為。',
        '第二段慢速回答內容，應該不會被完整送出。',
        '第三段慢速回答內容。',
        '第四段慢速回答內容。'
    ];
    const Q2 = 'Q2-停止測試';
    await sendText(Q2);
    await waitFor(() => {
        const nodes = Array.from(document.querySelectorAll('#assistant-messages .assistant-assistant'));
        const el = nodes[nodes.length - 1];
        return !!el && el.textContent.trim().length > 0 && !!document.querySelector('.assistant-stop');
    }, 15000, 'stream start');
    await page.click('.assistant-stop');
    await page.waitForTimeout(700);
    const stopped = await lastAssistant();
    const cancelledLabel = await tInPage('assistant.streamCancelled');
    check('停止後顯示已停止且不完整', !!stopped && stopped.cancelled === cancelledLabel, JSON.stringify(stopped && stopped.cancelled));
    check('停止後不顯示「保留為 AI 資料」', !!stopped && !stopped.keepDoc, JSON.stringify(stopped && stopped.keepDoc));
    const stoppedMessage = await findAssistantMessage('第一段慢速回答內容');
    check('半段回答以 cancelled 保存', !!stoppedMessage && stoppedMessage.status === 'cancelled', JSON.stringify(stoppedMessage && stoppedMessage.status));
    check('半段回答內容有保留', !!stoppedMessage && !!stoppedMessage.content.trim(), JSON.stringify(stoppedMessage && stoppedMessage.content.slice(0, 40)));
    // 重開面板：半段仍可見且仍標示已停止
    await page.click('#assistant-close');
    await page.waitForTimeout(200);
    await openPanel();
    await page.waitForTimeout(500);
    const restored = await page.evaluate(() => Array.from(
        document.querySelectorAll('#assistant-messages .assistant-assistant')
    ).map((el) => ({
        text: el.textContent || '',
        cancelled: el.querySelector('.assistant-cancelled')?.textContent?.trim() || ''
    })));
    const restoredStopped = restored.find((item) => item.text.includes('第一段慢速回答內容'));
    check('重新開啟會話仍看得到半段', !!restoredStopped, JSON.stringify(restored.map((i) => i.text.slice(0, 20))));
    check('重新開啟後仍標示已停止', !!restoredStopped && restoredStopped.cancelled === cancelledLabel, JSON.stringify(restoredStopped && restoredStopped.cancelled));

    // ── 情境 4：連續提問必須排隊 ─────────────────────────────────────
    console.log('\n[情境 4] 連續提問');
    await newSession();
    state.mode = 'slow';
    state.chunkDelayMs = 140;
    state.chunks = ['連續提問測試回答一。', '連續提問測試回答二。'];
    const Q3 = 'Q3-第一題';
    const Q4 = 'Q4-第二題';
    await sendText(Q3);
    await waitFor(() => !!document.querySelector('.assistant-stop'), 15000, 'first stream');
    const streamsBefore = state.streamRequests;
    await page.fill('#assistant-input', Q4);
    await page.click('#assistant-send');
    await page.waitForTimeout(300);
    const busyLabel = await tInPage('assistant.busy');
    const duringAsk = await page.evaluate(() => ({
        input: document.getElementById('assistant-input').value,
        hints: Array.from(document.querySelectorAll('#assistant-messages .assistant-hint')).map((el) => el.textContent.trim())
    }));
    check('回答中不得送出第二題', state.streamRequests === streamsBefore, `${state.streamRequests} / ${streamsBefore}`);
    check('回答中保留使用者輸入', duringAsk.input === Q4, JSON.stringify(duringAsk.input));
    check('回答中顯示忙碌提示', duringAsk.hints.some((text) => text.includes(busyLabel)), JSON.stringify(duringAsk.hints));
    await waitFor(() => !document.querySelector('.assistant-stop'), 20000, 'first stream end');
    await page.click('#assistant-send');
    await page.waitForTimeout(600);
    check('回答結束後可再送第二題', state.streamRequests > streamsBefore, `${state.streamRequests} / ${streamsBefore}`);

    // ── 情境 5：初始化期間同步連送（P1-3） ────────────────────────────
    console.log('\n[情境 5] 初始化期間同步連送');
    await newSession();
    state.mode = 'slow';
    state.chunkDelayMs = 160;
    state.chunks = Array.from({ length: 6 }, (_, i) => `初始化連送回答 ${i + 1}。`);
    const streamsBeforeRace = state.streamRequests;
    // 在同一個 task 內連續送出兩次：此時第一個 ask 還卡在建立會話／讀歷史的 await，
    // 停止按鈕尚未出現；忙碌鎖必須在這些 await 之前就取得。
    const syncSend = await page.evaluate(() => {
        const input = document.getElementById('assistant-input');
        const send = document.getElementById('assistant-send');
        input.value = 'Q5-FIRST-初始化連送';
        send.click();
        input.value = 'Q5-SECOND-初始化連送';
        send.click();
        return { input: input.value };
    });
    check('初始化連送：第二題未被清空', syncSend.input === 'Q5-SECOND-初始化連送', JSON.stringify(syncSend.input));
    await page.waitForTimeout(700);
    const raceState = await page.evaluate(() => ({
        stops: document.querySelectorAll('.assistant-stop').length,
        users: Array.from(document.querySelectorAll('#assistant-messages .assistant-user')).map((el) => el.textContent.trim()),
        hints: Array.from(document.querySelectorAll('#assistant-messages .assistant-hint')).map((el) => el.textContent.trim()),
        input: document.getElementById('assistant-input').value
    }));
    const raceBusyLabel = await tInPage('assistant.busy');
    check('初始化連送：只發一個串流請求', state.streamRequests - streamsBeforeRace === 1, `${state.streamRequests} / ${streamsBeforeRace}`);
    check('初始化連送：只出現一個停止按鈕', raceState.stops === 1, String(raceState.stops));
    check('初始化連送：只有第一題進入訊息列表', raceState.users.filter((text) => text.includes('Q5-')).length === 1 && raceState.users.some((text) => text.includes('Q5-FIRST')), JSON.stringify(raceState.users));
    check('初始化連送：第二題保留在輸入框', raceState.input === 'Q5-SECOND-初始化連送', JSON.stringify(raceState.input));
    check('初始化連送：顯示忙碌提示', raceState.hints.some((text) => text.includes(raceBusyLabel)), JSON.stringify(raceState.hints));
    await waitFor(() => !document.querySelector('.assistant-stop'), 20000, 'race stream end');

    // ── 情境 6：回答中新增／切換／刪除會話（F6） ──────────────────────
    console.log('\n[情境 6] 回答中的會話操作');
    await setArticle(ARTICLE_A);
    await newSession();
    await newSession();
    await page.waitForTimeout(500);
    const currentConvId = await page.evaluate(async () => {
        const mod = await import('/modules/reading-store.js');
        return mod.listConversations()[0]?.id || '';
    });
    const conversationsBefore = await page.evaluate(async () => {
        const mod = await import('/modules/reading-store.js');
        return mod.listConversations().length;
    });
    state.mode = 'slow';
    state.chunkDelayMs = 160;
    state.chunks = Array.from({ length: 8 }, (_, i) => `會話忙碌測試回答 ${i + 1}。`);
    const Q6 = 'Q6-回答中禁止切換會話';
    await sendText(Q6);
    await waitFor(() => !!document.querySelector('.assistant-stop'), 15000, 'F6 stop');
    const sessionBusyLabel = await tInPage('assistant.sessionBusy');

    await page.click('#assistant-new');
    await page.waitForTimeout(350);
    const afterNewWhileBusy = await page.evaluate(async ({ currentId }) => {
        const mod = await import('/modules/reading-store.js');
        return {
            stopCount: document.querySelectorAll('.assistant-stop').length,
            currentConvId: mod.listConversations()[0]?.id || '',
            stillExists: !!mod.getConversation(currentId),
            conversations: mod.listConversations().length,
            hints: Array.from(document.querySelectorAll('#assistant-messages .assistant-hint')).map((el) => el.textContent.trim()),
            userTexts: Array.from(document.querySelectorAll('#assistant-messages .assistant-user')).map((el) => el.textContent.trim())
        };
    }, { currentId: currentConvId });
    check('回答中新增會話：停止入口保留', afterNewWhileBusy.stopCount === 1, String(afterNewWhileBusy.stopCount));
    check('回答中新增會話：目前會話不變', afterNewWhileBusy.currentConvId === currentConvId && afterNewWhileBusy.stillExists, JSON.stringify(afterNewWhileBusy));
    check('回答中新增會話：不建立新會話', afterNewWhileBusy.conversations === conversationsBefore, `${afterNewWhileBusy.conversations} / ${conversationsBefore}`);
    check('回答中新增會話：目前訊息保留', afterNewWhileBusy.userTexts.some((text) => text.includes(Q6)), JSON.stringify(afterNewWhileBusy.userTexts));
    check('回答中新增會話：顯示會話忙碌提示', afterNewWhileBusy.hints.some((text) => text.includes(sessionBusyLabel)), JSON.stringify(afterNewWhileBusy.hints));

    await page.click('#assistant-history');
    await waitFor(() => !!document.querySelector('#assistant-history-panel'), 8000, 'history panel');
    const switchedWhileBusy = await page.evaluate(({ currentId }) => {
        const items = Array.from(document.querySelectorAll('#assistant-history-panel .ah-item'));
        const other = items.find((item) => item.getAttribute('data-id') !== currentId);
        other?.querySelector('button[data-act="open"]')?.click();
        return !!other;
    }, { currentId: currentConvId });
    await page.waitForTimeout(350);
    const afterSwitchWhileBusy = await page.evaluate(async ({ currentId }) => {
        const mod = await import('/modules/reading-store.js');
        return {
            stopCount: document.querySelectorAll('.assistant-stop').length,
            currentConvId: mod.listConversations()[0]?.id || '',
            stillExists: !!mod.getConversation(currentId),
            userTexts: Array.from(document.querySelectorAll('#assistant-messages .assistant-user')).map((el) => el.textContent.trim()),
            hints: Array.from(document.querySelectorAll('#assistant-messages .assistant-hint')).map((el) => el.textContent.trim())
        };
    }, { currentId: currentConvId });
    check('回答中切換會話：有另一個會話可點', switchedWhileBusy === true, String(switchedWhileBusy));
    check('回答中切換會話：目前會話不變', afterSwitchWhileBusy.currentConvId === currentConvId && afterSwitchWhileBusy.stillExists, JSON.stringify(afterSwitchWhileBusy));
    check('回答中切換會話：停止入口保留且訊息未被清空', afterSwitchWhileBusy.stopCount === 1 && afterSwitchWhileBusy.userTexts.some((text) => text.includes(Q6)), JSON.stringify(afterSwitchWhileBusy));
    check('回答中切換會話：顯示會話忙碌提示', afterSwitchWhileBusy.hints.some((text) => text.includes(sessionBusyLabel)), JSON.stringify(afterSwitchWhileBusy.hints));

    const deleteClicked = await page.evaluate(({ currentId }) => {
        const btn = document.querySelector(`#assistant-history-panel .ah-item[data-id="${currentId}"] button[data-act="delete"]`);
        btn?.click();
        return !!btn;
    }, { currentId: currentConvId });
    await page.waitForTimeout(350);
    const afterDeleteWhileBusy = await page.evaluate(async ({ currentId }) => {
        const mod = await import('/modules/reading-store.js');
        return {
            stopCount: document.querySelectorAll('.assistant-stop').length,
            confirmVisible: !!document.querySelector('.options-modal-overlay #confirm-btn'),
            stillExists: !!mod.getConversation(currentId),
            hints: Array.from(document.querySelectorAll('#assistant-messages .assistant-hint')).map((el) => el.textContent.trim())
        };
    }, { currentId: currentConvId });
    check('回答中刪除會話：有刪除入口可點', deleteClicked === true, String(deleteClicked));
    check('回答中刪除會話：不進入確認與刪除', afterDeleteWhileBusy.confirmVisible === false && afterDeleteWhileBusy.stillExists === true, JSON.stringify(afterDeleteWhileBusy));
    check('回答中刪除會話：停止入口保留並提示忙碌', afterDeleteWhileBusy.stopCount === 1 && afterDeleteWhileBusy.hints.some((text) => text.includes(sessionBusyLabel)), JSON.stringify(afterDeleteWhileBusy));

    await page.click('.assistant-stop');
    await waitFor(() => !document.querySelector('.assistant-stop'), 20000, 'F6 stop end');
    await page.waitForTimeout(500);
    const f6StoppedMessage = await findAssistantMessage('會話忙碌測試回答');
    check('停止後：半段回答保存在原會話', !!f6StoppedMessage && f6StoppedMessage.conversationId === currentConvId, JSON.stringify(f6StoppedMessage && { id: f6StoppedMessage.conversationId, status: f6StoppedMessage.status }));
    // 停止後會話操作恢復：可以建立新會話，且不會把舊會話內容寫進新會話。
    await page.evaluate(() => document.getElementById('assistant-history-panel')?.remove());
    await page.click('#assistant-new');
    await page.waitForTimeout(600);
    const afterStopNew = await page.evaluate(async ({ oldConvId, q6 }) => {
        const mod = await import('/modules/reading-store.js');
        const currentId = mod.listConversations()[0]?.id || '';
        const oldMessages = await mod.getMessages(oldConvId);
        const newMessages = currentId ? await mod.getMessages(currentId) : [];
        return {
            currentId,
            currentChanged: currentId !== oldConvId && !!currentId,
            boxEmpty: (document.getElementById('assistant-messages')?.textContent || '').trim() === '',
            oldHasQ6: oldMessages.some((m) => String(m.content || '').includes('會話忙碌測試回答')),
            newHasQ6: newMessages.some((m) => String(m.content || '').includes(q6))
        };
    }, { oldConvId: currentConvId, q6: Q6 });
    check('停止後：可以建立並切到新會話', afterStopNew.currentChanged === true, JSON.stringify(afterStopNew));
    check('停止後：新會話不帶舊會話訊息', afterStopNew.boxEmpty === true && afterStopNew.newHasQ6 === false, JSON.stringify(afterStopNew));
    check('停止後：舊會話仍保有半段回答', afterStopNew.oldHasQ6 === true, JSON.stringify(afterStopNew));

    // ── 情境 6（P2-T4）：向上閱讀不被拉回 ────────────────────────────
    if (PHASE2) {
        console.log('\n[情境 7] 輸入框、IME 與草稿');
        await newSession();
        state.mode = 'ok';
        state.chunks = ['送出後回答。'];
        const inputMeta = await page.evaluate(() => {
            const input = document.getElementById('assistant-input');
            return { tag: input?.tagName || '', rows: input?.getAttribute('rows') || '' };
        });
        check('助手輸入框改為 textarea rows=1', inputMeta.tag === 'TEXTAREA' && inputMeta.rows === '1', JSON.stringify(inputMeta));

        // Shift+Enter 用真實鍵盤事件在 textarea 插入換行，不得送出。
        await page.fill('#assistant-input', '');
        await page.click('#assistant-input');
        await page.keyboard.type('LINE-ONE');
        await page.keyboard.down('Shift');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Shift');
        await page.keyboard.type('LINE-TWO');
        const shiftState = await page.evaluate(() => ({
            value: document.getElementById('assistant-input').value,
            users: document.querySelectorAll('#assistant-messages .assistant-user').length
        }));
        check('Shift+Enter 插入換行且不送出', shiftState.value === 'LINE-ONE\nLINE-TWO' && shiftState.users === 0, JSON.stringify(shiftState));

        // IME 組字期間 Enter 不送出。
        const streamsBeforeIme = state.streamRequests;
        await page.evaluate(() => {
            const input = document.getElementById('assistant-input');
            input.value = '';
            input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
            input.value = '拼音候選';
            input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '拼音候選', inputType: 'insertCompositionText', isComposing: true }));
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, which: 229, bubbles: true, cancelable: true, isComposing: true }));
        });
        await page.waitForTimeout(300);
        const imeState = await page.evaluate(() => ({
            value: document.getElementById('assistant-input').value,
            users: document.querySelectorAll('#assistant-messages .assistant-user').length,
            stops: document.querySelectorAll('.assistant-stop').length
        }));
        check('IME Enter 不送出訊息', state.streamRequests === streamsBeforeIme && imeState.users === 0 && imeState.stops === 0, JSON.stringify({ ...imeState, streams: state.streamRequests, before: streamsBeforeIme }));
        // IME 組字完成後再按 Enter 才送出。
        await page.evaluate(() => {
            const input = document.getElementById('assistant-input');
            input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '拼音候選' }));
        });
        await page.focus('#assistant-input');
        await page.keyboard.press('Enter');
        await waitFor(() => document.querySelectorAll('#assistant-messages .assistant-user').length > 0, 8000, 'ime send');
        // 使用者訊息會先落地，串流請求可能晚幾百毫秒才到 mock server。
        await page.waitForTimeout(700);
        check('IME 組字結束後 Enter 可送出', state.streamRequests > streamsBeforeIme, `${state.streamRequests}/${streamsBeforeIme}`);
        await waitFor(() => !document.querySelector('.assistant-stop'), 15000, 'ime stream end');

        // 自動高度上限。
        const heights = await page.evaluate(() => {
            const input = document.getElementById('assistant-input');
            input.value = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            const cs = getComputedStyle(input);
            return { client: input.clientHeight, maxHeight: cs.maxHeight, overflowY: cs.overflowY, styleHeight: input.style.height };
        });
        check('textarea 最高 5 行後內捲', heights.client <= 144 && parseFloat(heights.maxHeight) <= 141 && heights.overflowY === 'auto', JSON.stringify(heights));

        // 錯誤後草稿恢復。
        await newSession();
        state.mode = 'errorEvent';
        state.chunks = ['錯誤前的片段。'];
        const draftQ = 'DRAFT-ERROR-要恢復';
        await page.fill('#assistant-input', draftQ);
        await page.click('#assistant-send');
        await waitFor(() => !!document.querySelector('#assistant-messages .assistant-retry'), 15000, 'draft error');
        const errorDraft = await page.evaluate(() => document.getElementById('assistant-input').value);
        check('錯誤後輸入框恢復原問題', errorDraft === draftQ, JSON.stringify(errorDraft));

        // 停止後草稿恢復。
        await newSession();
        state.mode = 'slow';
        state.chunkDelayMs = 100;
        state.chunks = ['停止前的片段一。', '停止前的片段二。'];
        const stopQ = 'DRAFT-STOP-要恢復';
        await page.fill('#assistant-input', stopQ);
        await page.click('#assistant-send');
        await waitFor(() => !!document.querySelector('.assistant-stop'), 15000, 'draft stop');
        await page.click('.assistant-stop');
        await waitFor(() => !document.querySelector('.assistant-stop'), 15000, 'draft stop end');
        await page.waitForTimeout(300);
        const stopDraft = await page.evaluate(() => document.getElementById('assistant-input').value);
        check('停止後輸入框恢復原問題', stopDraft === stopQ, JSON.stringify(stopDraft));

        // 使用者已在輸入框打新內容時，取消不得覆蓋。
        await newSession();
        state.mode = 'slow';
        state.chunkDelayMs = 100;
        state.chunks = ['覆蓋測試片段一。', '覆蓋測試片段二。'];
        const keptQ = 'DRAFT-KEEP-原問題';
        await page.fill('#assistant-input', keptQ);
        await page.click('#assistant-send');
        await waitFor(() => !!document.querySelector('.assistant-stop'), 15000, 'keep draft start');
        await page.fill('#assistant-input', 'NEW-TYPED-新內容');
        await page.click('.assistant-stop');
        await waitFor(() => !document.querySelector('.assistant-stop'), 15000, 'keep draft stop end');
        await page.waitForTimeout(300);
        const keptDraft = await page.evaluate(() => document.getElementById('assistant-input').value);
        check('使用者已輸入新內容時不覆蓋草稿', keptDraft === 'NEW-TYPED-新內容', JSON.stringify(keptDraft));

        console.log('\n[情境 8] 串流中向上閱讀');
        await newSession();
        state.mode = 'slow';
        state.chunkDelayMs = 90;
        const longChunk = '這是一段很長的回答內容，用來讓訊息區可以捲動。'.repeat(6);
        state.chunks = Array.from({ length: 8 }, () => longChunk);
        await sendText('Q5-捲動測試');
        await waitFor(() => {
            const box = document.getElementById('assistant-messages');
            return !!box && box.scrollHeight > box.clientHeight + 40;
        }, 20000, 'scrollable');
        await page.evaluate(() => { document.getElementById('assistant-messages').scrollTop = 0; });
        await page.waitForTimeout(450);
        const scrollState = await page.evaluate(() => ({
            top: document.getElementById('assistant-messages').scrollTop,
            hint: !!document.querySelector('.assistant-new-answer')
        }));
        check('向上閱讀時不被拉回底部', scrollState.top <= 8, JSON.stringify(scrollState));
        check('有新內容時顯示提示', scrollState.hint === true, JSON.stringify(scrollState));
        await page.click('.assistant-new-answer');
        await page.waitForTimeout(300);
        const bottom = await page.evaluate(() => {
            const box = document.getElementById('assistant-messages');
            return { gap: box.scrollHeight - box.scrollTop - box.clientHeight, hint: !!document.querySelector('.assistant-new-answer') };
        });
        check('點提示可回到最新回答', bottom.gap <= 40, JSON.stringify(bottom));
        check('回到最新後隱藏提示', bottom.hint === false, JSON.stringify(bottom));
        await waitFor(() => !document.querySelector('.assistant-stop'), 20000, 'scroll stream end');
    } else {
        console.log('\n[情境 8] 串流中向上閱讀：P2-T4 尚未實作，未執行（PHASE2=1 時啟用）');
    }

    check('沒有未預期的頁面錯誤', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)));

    await browser.close();
    await server.close();
    const failures = finish();
    if (failures) process.exit(1);
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
