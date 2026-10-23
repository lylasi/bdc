/**
 * 文章／助手驗收腳本共用的 mock 載具。
 *
 * 只依賴 Playwright route mock 與 localStorage／IndexedDB seeds：
 * 不連真實 AI、同步端點或 TTS，也不需要真實金鑰。
 */
const PROVIDER = 'https://provider.mock/v1';
const ENDPOINT = process.env.TEST_SYNC_ENDPOINT || 'http://127.0.0.1:19999/test-endpoint';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const PROFILE = {
    schemaVersion: 1,
    providers: {
        mock: {
            label: 'Mock',
            enabled: true,
            format: 'openai-chat',
            baseUrl: PROVIDER,
            apiUrl: `${PROVIDER}/chat/completions`,
            modelsUrl: `${PROVIDER}/models`,
            authMode: 'bearer',
            allowedModels: ['mock-model'],
            discoveredModels: [{ id: 'mock-model' }]
        }
    },
    credentials: {
        mock: {
            apiKey: 'mock-key',
            binding: {
                formatVersion: 1,
                format: 'openai-chat',
                apiUrl: `${PROVIDER}/chat/completions`,
                modelsUrl: `${PROVIDER}/models`,
                authMode: 'bearer'
            },
            version: 0,
            syncMode: 'local-only'
        }
    },
    taskModels: {
        articleParagraphTranslation: 'mock:mock-model',
        wordAnalysis: 'mock:mock-model',
        sentenceAnalysis: 'mock:mock-model',
        selectionAnalysis: 'mock:mock-model',
        assistant: 'mock:mock-model',
        default: 'mock:mock-model'
    },
    defaultModel: 'mock:mock-model'
};

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '600'
};

function createReporter(title) {
    const failures = [];
    if (title) console.log(`\n### ${title}`);
    const check = (name, condition, detail) => {
        if (condition) {
            console.log(`  ok   ${name}`);
            return true;
        }
        failures.push({ name, detail: detail === undefined ? '' : String(detail).slice(0, 500) });
        console.log(`  FAIL ${name}${detail !== undefined ? ' -- ' + String(detail).slice(0, 300) : ''}`);
        return false;
    };
    const finish = () => {
        console.log(`\n=== 結果：${failures.length ? failures.length + ' 項失敗' : '全部通過'} ===`);
        failures.forEach((item) => console.log(`  - ${item.name}: ${item.detail}`));
        return failures.length;
    };
    return { check, finish, failures };
}

/** 建立 mock AI profile 與介面語言的 init script。 */
function initScript(context, { locale = 'zh-CN', profile = PROFILE } = {}) {
    return context.addInitScript(({ endpoint, profile: prof, locale: loc }) => {
        window.__BDC_SYNC_ENDPOINT__ = endpoint;
        try {
            localStorage.setItem('bdc_ai_profile_v1:device:guest', JSON.stringify(prof));
            const raw = localStorage.getItem('pen_global_settings');
            const parsed = raw ? JSON.parse(raw) : {};
            parsed.language = { ...(parsed.language || {}), interfaceLocale: loc };
            localStorage.setItem('pen_global_settings', JSON.stringify(parsed));
        } catch (_) { /* ignore */ }
    }, { endpoint: ENDPOINT, profile, locale });
}

/** 直接寫入文章 docs（繞過 UI），讓歷史記錄／失敗狀態可重現。 */
async function seedDocs(page, docs) {
    return page.evaluate(async ({ endpoint, docs: items }) => {
        const scope = `${endpoint}::guest`;
        const db = await new Promise((resolve, reject) => {
            const req = indexedDB.open('bdc-articles');
            req.onupgradeneeded = () => {
                const d = req.result;
                if (!d.objectStoreNames.contains('docs')) d.createObjectStore('docs', { keyPath: 'key' });
                if (!d.objectStoreNames.contains('outbox')) d.createObjectStore('outbox', { keyPath: 'key' });
                if (!d.objectStoreNames.contains('state')) d.createObjectStore('state', { keyPath: 'scope' });
                if (!d.objectStoreNames.contains('drafts')) d.createObjectStore('drafts', { keyPath: 'scope' });
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        await new Promise((resolve) => {
            const tx = db.transaction('docs', 'readwrite');
            const store = tx.objectStore('docs');
            items.forEach((doc) => store.put({
                ...doc,
                scope,
                key: `${scope}\u0000${doc.id}`,
                dirty: false,
                pending: false,
                sizeBytes: (doc.body || '').length
            }));
            tx.oncomplete = resolve;
        });
        // 清掉先前的 AI 快取，確保真的打到 mock provider
        await new Promise((resolve) => {
            const req = indexedDB.deleteDatabase('bdc-cache');
            req.onsuccess = req.onerror = req.onblocked = () => resolve();
        });
        db.close();
        return items.length;
    }, { endpoint: ENDPOINT, docs });
}

function parsePostData(request) {
    try { return JSON.parse(request.postData() || '{}'); } catch (_) { return {}; }
}

function promptOf(body) {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    return messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
}

function countNumberedSentences(prompt) {
    return (String(prompt || '').match(/^\s*\d+\.\s+/gm) || []).length;
}

/**
 * 安裝 provider route。onChat 收到 { route, request, body, prompt }，
 * 由呼叫端決定要回成功、空結果或錯誤。
 */
async function installProviderRoutes(page, onChat) {
    await page.route(PROVIDER + '/**', async (route) => {
        const request = route.request();
        if (request.method() === 'OPTIONS') {
            return route.fulfill({ status: 204, headers: CORS_HEADERS });
        }
        if (request.url().includes('/models')) {
            return route.fulfill({
                status: 200,
                headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
                body: JSON.stringify({ data: [{ id: 'mock-model' }] })
            });
        }
        const body = parsePostData(request);
        return onChat({ route, request, body, prompt: promptOf(body) });
    });
}

function jsonReply(route, payload) {
    return route.fulfill({
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            choices: [{ message: { content: typeof payload === 'string' ? payload : JSON.stringify(payload) } }],
            usage: { total_tokens: 10 }
        })
    });
}

function httpError(route, status, message) {
    return route.fulfill({
        status,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: { message: message || `mock ${status}` } })
    });
}

/** 段落翻譯的空結果（保持 schema 合法，但沒有譯文）。 */
function emptyParagraphReply(prompt) {
    const count = countNumberedSentences(prompt);
    if (count > 0) return { sentences: Array.from({ length: count }, () => '') };
    return { chinese_translation: '', word_alignment: [], detailed_analysis: [] };
}

/** 段落翻譯的成功結果；句數由提示詞編號推算。 */
function translatedParagraphReply(prompt, marker = '譯句') {
    const count = countNumberedSentences(prompt);
    if (count > 0) {
        return {
            sentences: Array.from({ length: count }, (_, i) => `${marker}${i + 1}`),
            translation: `${marker}1`
        };
    }
    return { chinese_translation: `${marker}段落`, word_alignment: [], detailed_analysis: [] };
}

async function openRecord(page, key) {
    await page.click('#article-history-btn');
    await page.waitForTimeout(300);
    await page.click(`.ar-history-item[data-key="${key}"] .ar-history-open`);
    await page.waitForTimeout(500);
}

module.exports = {
    PROVIDER,
    ENDPOINT,
    PROFILE,
    CHROME,
    CORS_HEADERS,
    createReporter,
    initScript,
    seedDocs,
    installProviderRoutes,
    jsonReply,
    httpError,
    parsePostData,
    promptOf,
    countNumberedSentences,
    emptyParagraphReply,
    translatedParagraphReply,
    openRecord
};
