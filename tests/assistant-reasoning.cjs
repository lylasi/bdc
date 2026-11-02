/**
 * 助手「思考過程」驗收：推理模型的思考片段不得混進答案。
 *
 * 覆蓋：思考走獨立的收起區塊、正文不含思考、展開可讀、存檔內容乾淨、
 * 沒有思考時不長出區塊、切換 zh-HK 文案。
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/assistant-reasoning.cjs
 *
 * 供應商是本機 127.0.0.1 的 mock SSE 服務（Gemini 格式，thought: true 代表思考）；
 * 不連外網、不需要金鑰。
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const mock = require('./helpers/article-mock.cjs');
const { createMockStreamServer } = require('./helpers/mock-stream-server.cjs');

const PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${PORT}/`;

const ARTICLE = 'ALPHA-ARTICLE The reading room opens at eight. Visitors sign the book at the door.';
const THOUGHTS = ['先想一下。', '這題問的是被動語態。'];
const ANSWER = '被动语态把动作的承受者放在句首。';

const { check, finish } = mock.createReporter('助手思考過程');

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
    const context = await browser.newContext({ viewport: { width: 430, height: 900 } });
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

    const openPanel = async () => {
        await dismissModals();
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
    // 啟動時可能跳出同步／訪客資料提示；先關掉，否則浮窗入口被遮住。
    const dismissModals = async () => {
        await page.evaluate(() => {
            const modal = document.getElementById('app-modal');
            if (!modal || modal.classList.contains('hidden')) return;
            (modal.querySelector('.modal-close-btn') || modal.querySelector('.cancel-btn'))?.click();
            modal.classList.add('hidden');
        });
        await page.waitForTimeout(200);
    };
    const answerDump = () => page.evaluate(() => {
        const nodes = Array.from(document.querySelectorAll('#assistant-messages .assistant-assistant'));
        const el = nodes[nodes.length - 1];
        if (!el) return null;
        const reasoning = el.querySelector('.assistant-reasoning');
        return {
            text: (el.querySelector('.assistant-answer')?.textContent || '').trim(),
            bubbleText: (el.textContent || '').trim(),
            reasoningInsideAnswer: !!el.querySelector('.assistant-answer .assistant-reasoning'),
            reasoning: reasoning ? {
                open: reasoning.open,
                summary: (reasoning.querySelector('.assistant-reasoning-summary')?.textContent || '').trim(),
                body: (reasoning.querySelector('.assistant-reasoning-body')?.textContent || '').trim()
            } : null
        };
    });
    const waitFor = async (fn, timeout = 20000, label = '') => {
        try {
            await page.waitForFunction(fn, null, { timeout, polling: 100 });
            return true;
        } catch (_) {
            console.log(`  (等待逾時${label ? '：' + label : ''})`);
            return false;
        }
    };
    const storedAssistantTexts = (needle) => page.evaluate(async (marker) => {
        const mod = await import('/modules/reading-store.js');
        const out = [];
        for (const conv of mod.listConversations()) {
            const messages = await mod.getMessages(conv.id);
            for (const message of messages) {
                if (message.role !== 'assistant') continue;
                if (!String(message.content || '').includes(marker)) continue;
                out.push({ content: message.content || '', status: message.status || '' });
            }
        }
        return out;
    }, needle);

    // ── 情境 1：思考與答案分開呈現（zh-CN）──────────────────────────
    console.log('\n[情境 1] 思考不混進答案');
    await page.evaluate((text) => {
        const el = document.getElementById('article-input');
        el.value = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }, ARTICLE);
    await newSession();
    state.mode = 'ok';
    state.chunks = [ANSWER];
    state.thoughtChunks = THOUGHTS;
    await sendText('請解釋被動語態');
    await waitFor(() => {
        const nodes = Array.from(document.querySelectorAll('#assistant-messages .assistant-assistant'));
        const el = nodes[nodes.length - 1];
        return !!el && el.textContent.includes('被动语态把动作的承受者');
    }, 20000, 'answer');
    await page.waitForTimeout(400);
    const view = await answerDump();
    check('答案只包含正文', !!view && view.text.includes(ANSWER), JSON.stringify(view && view.text));
    check('思考內容沒有出現在答案裡', !!view && !view.text.includes('先想一下'), JSON.stringify(view && view.text));
    // 收起的 <details> 仍在 DOM 裡；要確認的是它不在正文節點內，且預設收起。
    check('思考區塊不是正文的一部分', !!view && view.reasoningInsideAnswer === false, JSON.stringify(view && view.reasoningInsideAnswer));
    check('長出獨立的思考區塊', !!view && !!view.reasoning, JSON.stringify(view && view.reasoning));
    check('思考區塊預設收起', !!view?.reasoning && view.reasoning.open === false, JSON.stringify(view && view.reasoning));
    const doneLabel = await tInPage('assistant.reasoning');
    check(
        '收起時的標題說明這是思考過程',
        !!view?.reasoning && view.reasoning.summary.startsWith(doneLabel),
        `${JSON.stringify(view?.reasoning?.summary)} / ${doneLabel}`
    );
    check(
        '思考區塊保留完整思考內容',
        !!view?.reasoning && view.reasoning.body === THOUGHTS.join(''),
        JSON.stringify(view?.reasoning?.body)
    );

    // 展開後看得到思考，且不影響答案。
    await page.click('#assistant-messages .assistant-assistant:last-child .assistant-reasoning-summary');
    await page.waitForTimeout(200);
    const opened = await answerDump();
    check('點標題可展開思考', !!opened?.reasoning && opened.reasoning.open === true, JSON.stringify(opened && opened.reasoning));
    check('展開後仍看得到正文', !!opened && opened.text.includes(ANSWER), JSON.stringify(opened && opened.text));

    // ── 情境 2：存檔內容不含思考（重開後不會又冒出思考）──────────────
    console.log('\n[情境 2] 存檔內容乾淨');
    const stored = await storedAssistantTexts(ANSWER);
    check('思考與答案分成不同存檔', stored.length >= 1, JSON.stringify(stored));
    check(
        '存檔只看得到答案',
        stored.every((item) => item.content.includes(ANSWER) && !item.content.includes('先想一下')),
        JSON.stringify(stored)
    );

    // ── 情境 3：沒有思考的模型不長區塊 ──────────────────────────────
    console.log('\n[情境 3] 一般模型不長思考區塊');
    await newSession();
    state.mode = 'ok';
    state.chunks = ['這是沒有思考過程的回答。'];
    state.thoughtChunks = [];
    await sendText('再問一次');
    await waitFor(() => {
        const nodes = Array.from(document.querySelectorAll('#assistant-messages .assistant-assistant'));
        const el = nodes[nodes.length - 1];
        return !!el && el.textContent.includes('這是沒有思考過程的回答');
    }, 20000, 'plain answer');
    await page.waitForTimeout(300);
    const plain = await answerDump();
    check('沒有思考時不長出區塊', !!plain && plain.reasoning === null, JSON.stringify(plain && plain.reasoning));
    check('一般回答照常顯示', !!plain && plain.text.includes('這是沒有思考過程的回答'), JSON.stringify(plain && plain.text));

    // ── 情境 4：串流途中思考也不會漏進答案 ──────────────────────────
    console.log('\n[情境 4] 串流途中不漏出思考');
    await newSession();
    state.mode = 'slow';
    state.chunkDelayMs = 260;
    state.chunks = ['第一段答案。', '第二段答案。'];
    state.thoughtChunks = THOUGHTS;
    await sendText('串流測試');
    const sawReasoningOnly = await waitFor(() => {
        const nodes = Array.from(document.querySelectorAll('#assistant-messages .assistant-assistant'));
        const el = nodes[nodes.length - 1];
        if (!el) return false;
        const reasoning = el.querySelector('.assistant-reasoning');
        const answer = (el.querySelector('.assistant-answer')?.textContent || '');
        return !!reasoning && answer.trim() === '' && !!document.querySelector('.assistant-stop');
    }, 15000, 'reasoning only');
    check('先到的是思考、答案還是空的', sawReasoningOnly, '');
    const streaming = await answerDump();
    check('串流中的答案沒有思考內容', !!streaming && !streaming.text.includes('先想一下'), JSON.stringify(streaming && streaming.text));
    const streamingLabel = await tInPage('assistant.reasoningPending');
    check(
        '思考中顯示「正在思考」',
        !!streaming?.reasoning && streaming.reasoning.summary === streamingLabel,
        `${JSON.stringify(streaming?.reasoning?.summary)} / ${streamingLabel}`
    );
    // 正文一開始就不該再標「正在思考」，否則答案串流期間標題會誤導。
    await waitFor(() => {
        const nodes = Array.from(document.querySelectorAll('#assistant-messages .assistant-assistant'));
        const el = nodes[nodes.length - 1];
        return !!el && (el.querySelector('.assistant-answer')?.textContent || '').includes('第一段答案');
    }, 15000, 'first answer chunk');
    const answering = await answerDump();
    check(
        '正文開始後不再是「正在思考」',
        !!answering?.reasoning && answering.reasoning.summary !== streamingLabel,
        JSON.stringify(answering?.reasoning?.summary)
    );
    await waitFor(() => {
        const nodes = Array.from(document.querySelectorAll('#assistant-messages .assistant-assistant'));
        const el = nodes[nodes.length - 1];
        return !!el && (el.querySelector('.assistant-answer')?.textContent || '').includes('第二段答案');
    }, 20000, 'slow answer');
    await page.waitForTimeout(300);
    const final = await answerDump();
    check('慢速串流完成後答案乾淨', !!final && final.text.includes('第一段答案') && !final.text.includes('先想一下'), JSON.stringify(final && final.text));

    // ── 情境 5：zh-HK 文案 ────────────────────────────────────────
    console.log('\n[情境 5] 香港繁體文案');
    await page.evaluate(async () => {
        const mod = await import('/modules/i18n.js');
        mod.setLocale('zh-HK');
    });
    await page.waitForTimeout(600);
    await newSession();
    state.mode = 'ok';
    state.chunks = ['香港繁體回答。'];
    state.thoughtChunks = ['香港繁體思考。'];
    await sendText('香港繁體測試');
    await waitFor(() => {
        const nodes = Array.from(document.querySelectorAll('#assistant-messages .assistant-assistant'));
        const el = nodes[nodes.length - 1];
        return !!el && (el.querySelector('.assistant-answer')?.textContent || '').includes('香港繁體回答');
    }, 20000, 'zh-HK answer');
    await page.waitForTimeout(300);
    const hk = await answerDump();
    const hkLabel = await tInPage('assistant.reasoning');
    check('繁體下思考標題用香港書面中文', hkLabel === '思考過程', hkLabel);
    check(
        '繁體下收起標題正確',
        !!hk?.reasoning && hk.reasoning.summary.startsWith(hkLabel),
        `${JSON.stringify(hk?.reasoning?.summary)} / ${hkLabel}`
    );
    check('繁體下答案仍不含思考', !!hk && hk.text.includes('香港繁體回答') && !hk.text.includes('香港繁體思考'), JSON.stringify(hk && hk.text));

    if (pageErrors.length) {
        console.log('\n頁面錯誤：');
        pageErrors.forEach((error) => console.log('  - ' + error));
    }
    check('沒有未捕捉的頁面錯誤', pageErrors.length === 0, JSON.stringify(pageErrors));

    const failures = finish();
    await browser.close();
    await server.close();
    process.exit(failures ? 1 : 0);
})().catch(async (error) => {
    console.error(error);
    process.exit(1);
});
