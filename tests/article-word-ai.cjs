/**
 * 詞卡內嵌 AI：精確位置、獨立對話、草稿、雙語、手機及串流移動／停止／重試。
 * PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/article-word-ai.cjs
 * 可用 ARTIFACT_DIR 保存截圖；全部 AI 請求使用隔離 mock。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const mock = require('./helpers/article-mock.cjs');
const { createMockStreamServer } = require('./helpers/mock-stream-server.cjs');

const BASE = `http://127.0.0.1:${process.env.PORT || 8313}/`;
const ID = 'art_word_ai';
const SENTENCE = 'A leader can also listen.';
const BODY = `The leader guides the team. ${SENTENCE}\n\nThe reading room opens at eight.`;
const DOC = {
    id: ID, title: 'Leadership', body: BODY, sourceType: 'paste', revision: 0,
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    lastOpenedAt: '2026-10-01T00:00:00.000Z',
    analysis: {
        chinese_translation: '领导者带领团队，也会聆听。', word_alignment: [],
        detailed_analysis: ['The leader guides the team.', SENTENCE].map((sentence) => ({
            word: 'leader', sentence,
            analysis: { meaning: '带领团队的人', pos: 'noun', phonetic: 'ˈliːdə', role: '主语' }
        })),
        sentence_analysis: [], phrase_analysis: [],
        paragraph_analysis: [
            { chinese_translation: '领导者带领团队，也会聆听。', word_alignment: [], detailed_analysis: [] },
            { chinese_translation: '阅览室八点开门。', word_alignment: [], detailed_analysis: [] }
        ]
    }
};
let checks = 0;
function check(name, condition, detail) {
    assert.ok(condition, `${name}: ${JSON.stringify(detail)}`);
    checks += 1;
    console.log(`PASS ${name}`);
}
const tooltip = (page) => page.locator('#word-analysis-tooltip');
const globalPanel = (page) => page.locator('#assistant-panel');
const chat = (page) => page.locator('.word-chat');
const input = (page) => chat(page).locator('[data-assistant-input]');
const askButton = (page) => tooltip(page).locator('.btn-ask-word-ai');
const translated = (page, key, params) => page.evaluate(async ({ key, params }) => (
    await import('/modules/i18n.js')
).t(key, params), { key, params });

async function openWord(page, occurrence = 1) {
    await page.locator('.interactive-word[data-word="leader"]').nth(occurrence).click();
    await tooltip(page).locator('.tooltip-meaning').waitFor();
    await askButton(page).waitFor({ state: 'visible' });
}
async function openChat(page) {
    await askButton(page).click();
    await chat(page).waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('.word-chat-send')?.disabled);
}
async function waitComplete(page, marker, minimumAnswers = 1) {
    await chat(page).locator('.assistant-assistant').filter({ hasText: marker }).last().waitFor();
    await page.waitForFunction(({ marker, minimumAnswers }) => {
        const answers = [...document.querySelectorAll('.word-chat .assistant-assistant')];
        const last = answers.at(-1);
        return answers.length >= minimumAnswers && last?.textContent.includes(marker)
            && last.dataset.messageStatus === 'complete' && !document.querySelector('.word-chat .assistant-stop');
    }, { marker, minimumAnswers });
}
async function openRecord(page) {
    await page.waitForFunction(() => !!window.__assistant?.openWord);
    await page.evaluate(() => document.querySelector('#app-modal:not(.hidden) .modal-close-btn')?.click());
    await page.locator('#article-history-btn').click();
    await page.locator(`.ar-history-item[data-key="${ID}"] .ar-history-open`).click();
    await page.locator('.paragraph-pair[data-paragraph-index="1"]').waitFor();
}
async function setup(browser, { locale = 'zh-CN', stream = false, profile = mock.PROFILE } = {}) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await mock.initScript(context, { locale, profile });
    await context.addInitScript((stream) => {
        const settings = JSON.parse(localStorage.getItem('pen_global_settings') || '{}');
        settings.reading = { ...settings.reading, articleSidebarCollapsed: true, translationMask: false };
        settings.assistant = { ...settings.assistant, stream, panelMode: 'floating' };
        localStorage.setItem('pen_global_settings', JSON.stringify(settings));
    }, stream);
    await context.route('**/*', (route) => ['127.0.0.1', 'localhost', 'provider.mock'].includes(
        new URL(route.request().url()).hostname
    ) ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(BASE + '#a', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__assistant?.openWord);
    await mock.seedDocs(page, [DOC]);
    await page.evaluate(async () => (await import('/modules/article-store.js')).reloadScope());
    await openRecord(page);
    return { context, page, errors };
}
async function screenshot(page, name) {
    if (!process.env.ARTIFACT_DIR) return;
    fs.mkdirSync(process.env.ARTIFACT_DIR, { recursive: true });
    await page.screenshot({
        path: path.join(process.env.ARTIFACT_DIR, name + '.png'),
        style: '#message-container { visibility: hidden !important; }'
    });
}
async function savedMessages(page) {
    return page.evaluate(async (id) => {
        const store = await import('/modules/reading-store.js');
        const conversations = store.listConversations(id);
        return (await Promise.all(conversations.map(async (item) => (await store.getMessages(item.id)).map(
            (message) => ({ ...message, sourceArticleId: item.articleId })
        )))).flat();
    }, ID);
}

async function runLocale(browser, locale) {
    const { context, page, errors } = await setup(browser, { locale, stream: locale === 'zh-HK' });
    const requests = [];
    const answer = 'AI-ANSWER: leader 表示带领团队的人。\n\n' + Array.from({ length: 8 }, (_, i) => `${i + 1}. 结合当前原句理解，这个词可以指组织者，也可以指善于聆听的领导者。`).join('\n');
    await mock.installProviderRoutes(page, async ({ route, body, prompt }) => {
        requests.push({ body, prompt });
        if (!body.stream) return mock.jsonReply(route, answer);
        return route.fulfill({
            status: 200, contentType: 'text/event-stream', headers: mock.CORS_HEADERS,
            body: `data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\ndata: [DONE]\n\n`
        });
    });
    try {
        await openWord(page);
        check(`${locale}：移除舊短語入口，保留精簡主要操作`, await tooltip(page).locator('.btn-analyze-phrase, .btn-analyze-phrase-custom, .tooltip-phrase-result').count() === 0
            && await tooltip(page).locator('.tooltip-primary-actions > button').count() === 4);
        check(`${locale}：AI 圖示具本地化標籤`, await askButton(page).getAttribute('aria-label') === await translated(page, 'article.askAi'));
        const actionBoxes = await tooltip(page).locator('.tooltip-primary-actions > button, .tooltip-more > summary').evaluateAll((nodes) => nodes.map((node) => {
            const box = node.getBoundingClientRect();
            return { top: box.top, bottom: box.bottom };
        }));
        check(`${locale}：五個操作保持單列`, actionBoxes.length === 5 && actionBoxes.every((box) => Math.abs(box.top - actionBoxes[0].top) < 1), actionBoxes);
        check(`${locale}：加詞本使用短標籤與完整提示`, await tooltip(page).locator('.btn-add-to-book .tooltip-action-label').textContent() === await translated(page, 'article.addToWordbookShort')
            && await tooltip(page).locator('.btn-add-to-book').getAttribute('aria-label') === await translated(page, 'article.addToWordbook'));
        await screenshot(page, `word-actions-${locale}`);
        await tooltip(page).locator('.tooltip-more > summary').click();
        await tooltip(page).locator('.tooltip-more-body:popover-open').waitFor();
        await screenshot(page, `word-actions-menu-${locale}`);
        await page.keyboard.press('Escape');
        check(`${locale}：收起更多選單後仍可直接問 AI`, await tooltip(page).isVisible() && await askButton(page).isVisible()
            && !await tooltip(page).locator('.btn-note-item').isVisible());
        await askButton(page).focus();
        await page.keyboard.press('Enter');
        await chat(page).waitFor({ state: 'visible' });
        await page.waitForFunction(() => !document.querySelector('.word-chat-send')?.disabled);
        check(`${locale}：在詞卡下方展開且聚焦空白輸入框`, await tooltip(page).isVisible()
            && await input(page).inputValue() === '' && await input(page).evaluate((el) => el === document.activeElement)
            && await tooltip(page).locator('.word-chat').count() === 1);
        check(`${locale}：開啟不發送、不開右下角助手`, requests.length === 0 && !await globalPanel(page).isVisible());
        check(`${locale}：展開狀態正確`, await askButton(page).getAttribute('aria-expanded') === 'true');
        const draft = '这个词可以怎样使用？';
        await input(page).fill(draft);
        await page.mouse.click(1260, 880);
        check(`${locale}：點擊空白處保留詞卡與草稿`, await tooltip(page).isVisible() && await input(page).inputValue() === draft);
        await screenshot(page, `word-ai-inline-empty-${locale}`);

        // 同詞的不同 occurrence 必須互相隔離。
        await openWord(page, 0);
        check(`${locale}：切到另一位置不帶入舊問答區`, await chat(page).count() === 0);
        await openChat(page);
        const firstId = await chat(page).getAttribute('data-word-conversation');
        check(`${locale}：另一位置輸入框獨立`, await input(page).inputValue() === '');
        const firstQuestion = 'FIRST-OCCURRENCE: 这里是什么意思？';
        await input(page).fill(firstQuestion);
        await page.keyboard.press('Enter');
        await waitComplete(page, 'AI-ANSWER:');
        await openWord(page, 1);
        check(`${locale}：回原位置自動恢復草稿`, await input(page).inputValue() === draft);
        const secondId = await chat(page).getAttribute('data-word-conversation');
        check(`${locale}：同詞不同句使用獨立會話`, firstId !== secondId, { firstId, secondId });
        await input(page).dispatchEvent('compositionstart');
        await input(page).dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
        await input(page).dispatchEvent('compositionend');
        check(`${locale}：輸入法確認不誤發送`, requests.length === 1 && await input(page).inputValue() === draft);
        await input(page).focus();
        await page.keyboard.press('Shift+Enter');
        check(`${locale}：Shift+Enter 換行`, (await input(page).inputValue()).endsWith('\n') && requests.length === 1);
        const question = 'SECOND-OCCURRENCE: 这里可以换成什么词？';
        await input(page).fill(question);
        await chat(page).locator('.word-chat-send').click();
        await waitComplete(page, 'AI-ANSWER:');
        check(`${locale}：按送出才請求並沿用共用 AI 模式`, requests.length === 2 && !!requests[1].body.stream === (locale === 'zh-HK'));
        const reference = await translated(page, 'article.askAiWordReference', { quote: 'leader', sentence: SENTENCE });
        check(`${locale}：請求帶完整文章、所選原句及問題`, requests[1].prompt.includes(BODY)
            && requests[1].prompt.includes(reference) && requests[1].prompt.includes(question));
        check(`${locale}：請求不混入另一位置的歷史`, !requests[1].prompt.includes(firstQuestion));
        await input(page).fill('FOLLOW-UP: 给一个更简单的例子');
        await page.keyboard.press('Enter');
        await waitComplete(page, 'AI-ANSWER:', 2);
        check(`${locale}：可在詞卡追問並包含原對話`, requests.length === 3 && requests[2].prompt.includes(question) && requests[2].prompt.includes('AI-ANSWER:'));
        const messages = await savedMessages(page);
        const saved = messages.find((item) => item.role === 'user' && item.content === question);
        check(`${locale}：問題保存到精確第二個單詞`, saved?.sourceArticleId === ID && saved.learningItemId && saved.contentVersion
            && saved.anchor?.quote === 'leader' && saved.anchor.start === BODY.indexOf('leader', BODY.indexOf('leader') + 1), saved);
        check(`${locale}：回答保留同一單詞來源`, messages.some((item) => item.role === 'assistant' && item.learningItemId === saved.learningItemId && item.content.includes('AI-ANSWER:')));
        const metrics = await chat(page).locator('[data-assistant-messages]').evaluate((el) => ({ height: el.clientHeight, scroll: el.scrollHeight }));
        check(`${locale}：長回答限制高度並在區內捲動`, metrics.height <= 197 && metrics.scroll > metrics.height && await input(page).isVisible(), metrics);
        await screenshot(page, `word-ai-inline-answer-${locale}`);

        const windowDraft = '保留正在写的追问';
        await input(page).fill(windowDraft);
        await chat(page).evaluate((el) => { window.__wordChatNode = el; });
        await chat(page).locator('.word-chat-window').click();
        check(`${locale}：彈出沿用原節點、對話及草稿`, await chat(page).evaluate((el) => el === window.__wordChatNode)
            && await page.locator('.word-chat-popped').count() === 1 && await input(page).inputValue() === windowDraft
            && !await globalPanel(page).isVisible());
        await screenshot(page, `word-ai-window-${locale}`);
        await tooltip(page).locator('.tooltip-close').click();
        await chat(page).locator('.word-chat-window').click();
        check(`${locale}：關閉原詞卡後仍可返回同一位置`, await tooltip(page).isVisible() && await tooltip(page).locator('.word-chat').count() === 1
            && await input(page).inputValue() === windowDraft && await chat(page).evaluate((el) => el === window.__wordChatNode));
        await chat(page).locator('.word-chat-close').click();
        check(`${locale}：問答可收起且焦點回 AI 圖示`, await chat(page).count() === 0 && await askButton(page).evaluate((el) => el === document.activeElement));
        await openChat(page);
        check(`${locale}：重新展開保留對話及草稿`, await input(page).inputValue() === windowDraft && await chat(page).locator('.assistant-user').count() === 2);
        await page.keyboard.press('Escape');
        check(`${locale}：Escape 關閉詞卡並回到原詞`, !await tooltip(page).isVisible()
            && await page.locator('.interactive-word[data-word="leader"]').nth(1).evaluate((el) => el === document.activeElement));

        // 重載後對話由 IndexedDB 還原；未送出草稿只存在當頁。
        await page.reload({ waitUntil: 'domcontentloaded' });
        await openRecord(page);
        await openWord(page);
        await openChat(page);
        await chat(page).locator('.assistant-user').filter({ hasText: question }).waitFor();
        check(`${locale}：重載後恢復同一位置的歷史`, await chat(page).getAttribute('data-word-conversation') === secondId
            && await chat(page).locator('.assistant-user').count() === 2 && await input(page).inputValue() === '');
        await input(page).fill(windowDraft);
        const alternate = locale === 'zh-CN' ? 'zh-HK' : 'zh-CN';
        await page.evaluate(async (value) => (await import('/modules/i18n.js')).setLocale(value), alternate);
        check(`${locale}：即時換語言不改寫歷史或草稿`, await input(page).inputValue() === windowDraft
            && await input(page).getAttribute('placeholder') === await translated(page, 'assistant.wordInputPlaceholder')
            && await chat(page).locator('.assistant-user').filter({ hasText: question }).count() === 1);
        await chat(page).locator('.word-chat-window').click();
        const keepDocument = chat(page).locator('.assistant-keep-doc').last();
        check(`${locale}：大視窗的保留文件按鈕同步切換語言`, await keepDocument.textContent() === await translated(page, 'assistant.keepAsDocument'));
        await keepDocument.click();
        await keepDocument.locator('xpath=self::*[contains(@class,"is-saved")]').waitFor();
        await page.evaluate(async (value) => (await import('/modules/i18n.js')).setLocale(value), locale);
        check(`${locale}：已保留文件狀態切換語言後仍正確`, await keepDocument.textContent() === await translated(page, 'assistant.documentSaved')
            && await keepDocument.isDisabled() && await input(page).inputValue() === windowDraft);
        await chat(page).locator('.word-chat-window').click();
        await tooltip(page).locator('.tooltip-close').click();

        await page.setViewportSize({ width: 390, height: 844 });
        await openWord(page);
        const mobileBox = await tooltip(page).boundingBox();
        check(`${locale}：手機詞卡及輸入完整位於可視範圍`, mobileBox.x >= 0 && mobileBox.x + mobileBox.width <= 391
            && mobileBox.y >= 0 && mobileBox.y + mobileBox.height <= 845
            && await tooltip(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1), mobileBox);
        await screenshot(page, `word-ai-mobile-${locale}`);
        const touchTargets = await tooltip(page).locator('.tooltip-primary-actions > button, .tooltip-more > summary').evaluateAll((nodes) => nodes.map((node) => {
            const box = node.getBoundingClientRect();
            return { width: box.width, height: box.height };
        }));
        check(`${locale}：手機主要操作點擊區至少 44px`, touchTargets.every((box) => box.width >= 44 && box.height >= 44), touchTargets);
        await page.setViewportSize({ width: 320, height: 720 });
        await tooltip(page).locator('.tooltip-more > summary').click();
        await tooltip(page).locator('.tooltip-more-body:popover-open').waitFor();
        const menuBox = await tooltip(page).locator('.tooltip-more-body').boundingBox();
        check(`${locale}：320px 手機工具列與選單無溢出`, menuBox.x >= 0 && menuBox.x + menuBox.width <= 320
            && menuBox.y >= 0 && menuBox.y + menuBox.height <= 720
            && await tooltip(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1), menuBox);
        await screenshot(page, `word-actions-mobile-menu-${locale}`);
        await page.keyboard.press('Escape');
        await page.setViewportSize({ width: 390, height: 844 });
        // 模擬縮小的可視視窗，檢查鍵盤升起後輸入仍可點擊。
        await page.evaluate(() => {
            Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 420 });
            window.visualViewport.dispatchEvent(new Event('resize'));
        });
        const inputBox = await input(page).boundingBox();
        check(`${locale}：鍵盤升起後輸入框保留在可視範圍`, inputBox.y >= 0 && inputBox.y + inputBox.height <= 421, inputBox);
        await screenshot(page, `word-ai-mobile-keyboard-${locale}`);
        await page.evaluate(() => {
            delete window.visualViewport.height;
            window.visualViewport.dispatchEvent(new Event('resize'));
        });
        await tooltip(page).locator('.tooltip-close').click();
        await page.evaluate(async () => (await import('/modules/settings.js')).saveGlobalSettings({ assistant: { enabled: false } }));
        await openWord(page);
        await askButton(page).click();
        const unavailable = await translated(page, 'assistant.unavailable');
        await page.locator('#message-container').getByText(unavailable, { exact: true }).waitFor();
        check(`${locale}：停用時保留詞卡並提示原因`, await tooltip(page).isVisible() && await chat(page).count() === 0 && requests.length === 3);
        check(`${locale}：無 JavaScript 執行錯誤`, errors.length === 0, errors);
    } finally {
        await context.close();
    }
}

function streamingProfile(baseUrl) {
    const binding = {
        formatVersion: 1, format: 'gemini', authMode: 'google',
        apiUrl: `${baseUrl}/v1beta/models/%7Bmodel%7D:generateContent`, modelsUrl: `${baseUrl}/v1beta/models`
    };
    return {
        schemaVersion: 1,
        providers: { mock: { ...binding, baseUrl, label: 'Mock', enabled: true, allowedModels: ['mock-model'], discoveredModels: [{ id: 'mock-model' }] } },
        credentials: { mock: { apiKey: 'test-only', binding, version: 0, syncMode: 'local-only' } },
        taskModels: { assistant: 'mock:mock-model', default: 'mock:mock-model' }, defaultModel: 'mock:mock-model'
    };
}

async function runStreaming(browser) {
    const server = createMockStreamServer();
    const serverUrl = await server.listen();
    const { state } = server;
    const { context, page, errors } = await setup(browser, { stream: true, profile: streamingProfile(serverUrl) });
    try {
        await openWord(page);
        await openChat(page);
        state.mode = 'slow';
        state.chunkDelayMs = 450;
        state.chunks = ['STREAM-START。', '第二部分。', '第三部分。', 'STREAM-END。'];
        await input(page).fill('STREAM: 解释这个词');
        await page.keyboard.press('Enter');
        await chat(page).locator('.assistant-assistant').filter({ hasText: 'STREAM-START' }).waitFor();
        await input(page).fill('STREAM-DRAFT');
        await chat(page).evaluate((el) => { window.__streamNode = el; });
        await chat(page).locator('.word-chat-window').click();
        check('串流：彈出時仍在回答且沿用同一節點', await chat(page).locator('.assistant-stop').isVisible()
            && await chat(page).evaluate((el) => el === window.__streamNode) && await input(page).inputValue() === 'STREAM-DRAFT');
        await chat(page).locator('.word-chat-window').click();
        check('串流：返回詞卡時不中斷', await tooltip(page).locator('.word-chat').count() === 1 && await chat(page).locator('.assistant-stop').isVisible());
        await waitComplete(page, 'STREAM-END');
        check('串流：彈出返回只發送一次請求且保留追問草稿', state.streamRequests === 1 && await input(page).inputValue() === 'STREAM-DRAFT');

        state.chunks = ['STOP-PART。', '第二段。', '第三段。', '第四段。'];
        await input(page).fill('STOP: 测试停止');
        await page.keyboard.press('Enter');
        await chat(page).locator('.assistant-assistant').filter({ hasText: 'STOP-PART' }).waitFor();
        await chat(page).locator('.assistant-stop').click();
        await chat(page).locator('.assistant-cancelled').waitFor();
        await page.waitForFunction(() => !!document.querySelector('.word-chat [data-message-status="cancelled"]'));
        const stopped = (await savedMessages(page)).find((message) => message.role === 'assistant' && message.content.includes('STOP-PART'));
        check('串流：詞卡可停止，半段以 cancelled 保存', stopped?.status === 'cancelled' && !stopped.content.includes('第四段'), stopped);
        check('串流：停止後恢復問題草稿', await input(page).inputValue() === 'STOP: 测试停止');

        state.mode = 'errorEvent';
        state.chunks = ['RETRY-PART。'];
        const retryQuestion = 'RETRY: 为什么用这个词';
        await input(page).fill(retryQuestion);
        await page.keyboard.press('Enter');
        await chat(page).locator('.assistant-retry').waitFor();
        check('串流：失敗可在詞卡重試且保留半段及草稿', await chat(page).locator('.assistant-error').isVisible()
            && await input(page).inputValue() === retryQuestion);
        await openWord(page, 0);
        await openChat(page);
        await input(page).fill('OTHER-DRAFT');
        await openWord(page, 1);
        state.mode = 'ok';
        state.chunks = ['RETRY-SUCCESS。'];
        await chat(page).locator('.assistant-retry').click();
        await waitComplete(page, 'RETRY-SUCCESS');
        const request = JSON.stringify(state.requests.at(-1).body);
        check('串流：切詞後仍可按原問題重試', request.includes(retryQuestion) && request.includes(SENTENCE) && !request.includes('OTHER-DRAFT'));
        check('串流：重試不重複保存問題', (await savedMessages(page)).filter((message) => message.role === 'user' && message.content === retryQuestion).length === 1);

        // scope 切換必須移除視窗並停止舊請求，不能把回答寫入新帳戶。
        state.mode = 'slow';
        state.chunks = ['SCOPE-OLD。', '不应写入新范围。', '第三段。', '第四段。'];
        await input(page).fill('SCOPE: 测试账户切换');
        await page.keyboard.press('Enter');
        await chat(page).locator('.assistant-assistant').filter({ hasText: 'SCOPE-OLD' }).waitFor();
        await chat(page).locator('.word-chat-window').click();
        const previousScope = await page.evaluate(async () => {
            const articles = await import('/modules/article-store.js');
            const reading = await import('/modules/reading-store.js');
            const previous = articles.getArticleScope();
            await articles.reloadScope(`${previous}-switched`);
            await reading.reloadReadingScope();
            document.dispatchEvent(new CustomEvent('bdc:articles-scope-changed'));
            return previous;
        });
        check('串流：範圍切換移除詞卡問答及大視窗', await chat(page).count() === 0);
        await page.waitForFunction(() => !document.querySelector('.assistant-stop'));
        check('串流：新範圍不帶入舊問答', (await savedMessages(page)).length === 0);
        await page.evaluate(async (previous) => {
            await (await import('/modules/article-store.js')).reloadScope(previous);
            await (await import('/modules/reading-store.js')).reloadReadingScope();
        }, previousScope);
        const afterScope = await savedMessages(page);
        check('串流：失效範圍不保存舊回答', !afterScope.some((message) => message.role === 'assistant' && message.content.includes('SCOPE-OLD')));
        check('串流：無 JavaScript 執行錯誤', errors.length === 0, errors);
    } finally {
        await context.close();
        await server.close();
    }
}

async function runGlobalIsolation(browser) {
    const { context, page, errors } = await setup(browser);
    const requests = [];
    await mock.installProviderRoutes(page, async ({ route, prompt }) => {
        requests.push(prompt);
        return mock.jsonReply(route, 'ISOLATION-ANSWER');
    });
    try {
        await openWord(page);
        await openChat(page);
        await input(page).fill('WORD-ONLY-QUESTION');
        await page.keyboard.press('Enter');
        await waitComplete(page, 'ISOLATION-ANSWER');
        const wordId = await chat(page).getAttribute('data-word-conversation');
        await tooltip(page).locator('.tooltip-close').click();
        await page.locator('#assistant-fab').click();
        // 還原是非同步；留時間檢查「未載入詞卡歷史」這個否定條件。
        await page.waitForTimeout(200);
        check('會話隔離：首次開主助手不載入詞卡對話', await globalPanel(page).locator('.assistant-user').count() === 0);
        await page.evaluate(async (id) => window.__assistant.send('GLOBAL-ONLY-QUESTION', id), ID);
        check('會話隔離：主助手首次提問不帶詞卡問答', requests.length === 2 && !requests[1].includes('WORD-ONLY-QUESTION'));
        const allMessages = await savedMessages(page);
        check('會話隔離：主助手另建文章會話', allMessages.find((message) => message.content === 'GLOBAL-ONLY-QUESTION')?.conversationId !== wordId);

        await globalPanel(page).locator('#assistant-close').click();
        await openWord(page);
        await input(page).fill('WORD-SECOND-QUESTION');
        await page.keyboard.press('Enter');
        await waitComplete(page, 'ISOLATION-ANSWER', 2);
        await tooltip(page).locator('.tooltip-close').click();
        await page.evaluate(() => localStorage.removeItem('assistantCurrentMap'));
        await page.locator('#assistant-fab').click();
        await globalPanel(page).locator('.assistant-user').filter({ hasText: 'GLOBAL-ONLY-QUESTION' }).waitFor();
        check('會話隔離：未指定會話時回到文章對話', !await globalPanel(page).innerText().then((text) => text.includes('WORD-SECOND-QUESTION')));
        const wordMessages = await page.evaluate(async (id) => (await import('/modules/reading-store.js')).getMessages(id), wordId);
        check('會話隔離：詞卡會話保持獨立', wordMessages.filter((message) => message.role === 'user').length === 2
            && !wordMessages.some((message) => message.content === 'GLOBAL-ONLY-QUESTION'));
        check('會話隔離：無 JavaScript 執行錯誤', errors.length === 0, errors);
    } finally {
        await context.close();
    }
}

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: mock.CHROME });
    try {
        for (const locale of ['zh-CN', 'zh-HK']) await runLocale(browser, locale);
        await runStreaming(browser);
        await runGlobalIsolation(browser);
        console.log(`\n全部通過：${checks} 項檢查。`);
    } finally {
        await browser.close();
    }
})().catch((error) => { console.error(error); process.exitCode = 1; });
