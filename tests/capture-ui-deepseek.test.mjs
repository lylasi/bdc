// DeepSeek 獨立補測：extension/capture-ui.js 的 UI 競態與錯誤訊息。
//
// 做法：把受測檔 extension/capture-ui.js 與它真正相依的 shared/*.mjs 原封不動複製到暫存
// 目錄（並斷言內容與 repo 完全相同），只把「網路／儲存／session／i18n」換成可控 stub。
// 因此這裡測的是產品程式本身，不是複刻一份邏輯：
//   - 收藏失敗不得顯示成已加入、待傳不得憑空消失
//   - 收藏途中換詞書／重新查詞／帳戶事件的競態
//   - 錯誤訊息是否對得上實際情況
// DOM 用最小 shim（不是 jsdom），只實作 capture-ui.js 實際用到的介面。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { captureScopeKey } from '../shared/capture-client.mjs';

const here = fileURLToPath(new URL('..', import.meta.url));

// ── 最小 DOM ────────────────────────────────────────────────────────────────

class ClassList {
    constructor() { this.set = new Set(); }
    toggle(name, force) {
        const on = force === undefined ? !this.set.has(name) : !!force;
        if (on) this.set.add(name); else this.set.delete(name);
        return on;
    }
    add(name) { this.set.add(name); }
    remove(name) { this.set.delete(name); }
    contains(name) { return this.set.has(name); }
}

class Element {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.children = [];
        this.listeners = new Map();
        this.classList = new ClassList();
        this.attributes = {};
        this.text = '';
        this.hidden = false;
        this.disabled = false;
        this.value = '';
        this.className = '';
    }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() {
        return this.children.length ? this.children.map((child) => child.textContent).join('') : this.text;
    }
    appendChild(child) { this.children.push(child); return child; }
    replaceChildren(...nodes) { this.children = [...nodes]; }
    addEventListener(type, handler) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(handler);
    }
    async click() {
        for (const handler of this.listeners.get('click') || []) await handler({ type: 'click' });
    }
    setAttribute(name, value) { this.attributes[name] = value; }
}

function elements() {
    const dom = {};
    for (const id of ['book', 'save', 'refresh', 'source', 'notice', 'pending', 'pendingSummary', 'pendingList']) {
        dom[id] = new Element('div');
    }
    dom.captureBook = new Element('select');
    dom.captureSave = dom.save;
    dom.captureRefresh = dom.refresh;
    dom.captureSource = dom.source;
    dom.captureNotice = dom.notice;
    dom.capturePending = dom.pending;
    dom.capturePendingSummary = dom.pendingSummary;
    dom.capturePendingList = dom.pendingList;
    return dom;
}

// ── 暫存模組圖：原檔複製 + 只替換網路／儲存／session／i18n ─────────────────

const SHARED = ['shared/capture-client.mjs', 'shared/capture-protocol.mjs', 'shared/reading-protocol.mjs', 'shared/vocabulary-source.mjs'];

function buildHarnessModule(t) {
    const dir = mkdtempSync(join(tmpdir(), 'bdc-capture-ui-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    mkdirSync(join(dir, 'modules'));
    mkdirSync(join(dir, 'shared'));
    const source = readFileSync(join(here, 'extension/capture-ui.js'));
    writeFileSync(join(dir, 'capture-ui.mjs'), source);
    assert.equal(readFileSync(join(dir, 'capture-ui.mjs')).compare(source), 0, '受測檔必須與 repo 完全相同');
    for (const relative of SHARED) {
        const original = readFileSync(join(here, relative));
        copyFileSync(join(here, relative), join(dir, relative));
        assert.equal(readFileSync(join(dir, relative)).compare(original), 0, `${relative} 必須與 repo 完全相同`);
    }
    writeFileSync(join(dir, 'modules/extension-capture.js'),
        'export function getExtensionCaptureClient() { return globalThis.__captureClient; }\n');
    writeFileSync(join(dir, 'modules/sync-cloudflare.js'),
        'export function captureAuthSession() { return globalThis.__captureSession; }\n'
        + 'export function isAuthSessionCurrent(session) { return !!globalThis.__captureSessionCurrent && globalThis.__captureSessionCurrent(session); }\n');
    writeFileSync(join(dir, 'modules/i18n.js'),
        'export function t(key, params) {\n'
        + '    const keys = Object.keys(params || {});\n'
        + "    return keys.length ? key + JSON.stringify(params) : String(key);\n"
        + '}\n');
    return pathToFileURL(join(dir, 'capture-ui.mjs')).href;
}

// ── 受控 client ────────────────────────────────────────────────────────────

function defer() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const loggedIn = { loggedIn: true, endpoint: 'https://sync.example', userId: 'alice', token: 'tok-1', generation: 1 };

function fakeClient(hooks = {}) {
    const state = {
        calls: { books: 0, pending: 0, enqueue: 0, send: 0, retry: 0, cancel: 0 },
        queue: [],
        pendingItems: (hooks.pending || []).slice(),
        retryResults: [],
        booksResult: hooks.booksResult || { books: [{ id: 'book', name: 'Book' }], defaultBookId: 'book' },
        booksError: hooks.booksError || null
    };
    const wait = (kind, value) => {
        const step = defer();
        state.queue.push({ kind, step, value });
        return step.promise;
    };
    state.client = {
        async books() {
            state.calls.books += 1;
            if (state.booksError) throw state.booksError;
            return state.booksResult;
        },
        async pending() { state.calls.pending += 1; return state.pendingItems.slice(); },
        enqueue(input) {
            state.calls.enqueue += 1;
            const payload = { ...input, requestId: `req-${state.calls.enqueue}` };
            return wait('enqueue', {
                key: `bdc_capture_outbox_v1:x:${payload.requestId}`, endpoint: loggedIn.endpoint,
                userId: loggedIn.userId, payload, createdAt: '2026-11-06T00:00:00.000Z'
            });
        },
        send(operation) {
            state.calls.send += 1;
            return wait('send', {
                ok: true, requestId: operation.payload.requestId, bookId: operation.payload.bookId, entryId: 'entry-1', revision: 1
            });
        },
        async retry() {
            state.calls.retry += 1;
            return state.retryResults.slice();
        },
        cancel(operation) {
            state.calls.cancel += 1;
            state.pendingItems = state.pendingItems.filter((item) => item.key !== operation.key);
            return wait('cancel', undefined);
        }
    };
    state.shift = (kind) => {
        const index = state.queue.findIndex((entry) => entry.kind === kind);
        if (index < 0) throw new Error(`沒有待決的 ${kind}（目前：${state.kinds().join(',') || '空'}）`);
        const [entry] = state.queue.splice(index, 1);
        return entry;
    };
    state.resolve = (kind, override) => {
        const entry = state.shift(kind);
        entry.step.resolve(override === undefined ? entry.value : override);
        return entry;
    };
    state.reject = (kind, error) => {
        const entry = state.shift(kind);
        entry.step.reject(error);
        return entry;
    };
    state.kinds = () => state.queue.map((entry) => entry.kind);
    return state;
}

function installGlobals(t, { client, session, storage: providedStorage }) {
    const storage = providedStorage || { values: {}, calls: [] };
    const chromeStorage = {
        async get(key) {
            storage.calls.push(['get', key]);
            if (key === null || key === undefined) return { ...storage.values };
            return key in storage.values ? { [key]: storage.values[key] } : {};
        },
        async set(items) { storage.calls.push(['set', Object.keys(items)]); Object.assign(storage.values, structuredClone(items)); },
        async remove(key) { storage.calls.push(['remove', key]); delete storage.values[key]; }
    };
    const onChangedListeners = [];
    globalThis.__captureClient = client;
    globalThis.__captureSession = session;
    globalThis.__captureSessionCurrent = (captured) => JSON.stringify(captured) === JSON.stringify(globalThis.__captureSession);
    globalThis.document = { createElement: (tag) => new Element(tag) };
    globalThis.chrome = {
        storage: { local: chromeStorage, onChanged: { addListener: (handler) => onChangedListeners.push(handler) } }
    };
    globalThis.window = { addEventListener: () => {} };
    t.after(() => {
        delete globalThis.document;
        delete globalThis.window;
        delete globalThis.chrome;
        delete globalThis.__captureClient;
        delete globalThis.__captureSession;
        delete globalThis.__captureSessionCurrent;
    });
    return { storage, onChangedListeners };
}

async function build(t, options = {}) {
    const moduleUrl = options.moduleUrl || buildHarnessModule(t);
    const client = fakeClient(options);
    const globals = installGlobals(t, {
        client: client.client, session: options.session || loggedIn, storage: options.storage
    });
    const { createCaptureUI } = await import(moduleUrl);
    const dom = elements();
    const ui = createCaptureUI(dom);
    return { ui, dom, client, ...globals };
}

function showWord(ui, overrides = {}) {
    ui.showResult(
        { text: 'plunge', meaning: '暴跌', phonetic: 'plʌndʒ', pos: 'verb', ...overrides.result },
        { text: 'plunge', sentence: 'Stocks plunge.', context: 'Stocks plunge. Markets.', ...overrides.query },
        'zh-HK'
    );
}

async function saveOnce(h, { resolveSend = true } = {}) {
    const clicking = h.dom.captureSave.click();
    await tick();
    h.client.resolve('enqueue');
    await tick();
    if (resolveSend) h.client.resolve('send');
    await clicking;
}

// ── 1. 基本流程與錯誤訊息 ──────────────────────────────────────────────────

test('載入詞書後：有結果才可按收藏，成功後顯示已加入且清單消失', async (t) => {
    const h = await build(t);
    await h.ui.sync();
    assert.equal(h.dom.captureBook.value, 'book', '伺服器明確給的合法預設詞書應被選取');
    assert.equal(h.dom.captureSave.disabled, true, '還沒有查詞結果時不得按收藏');
    showWord(h.ui);
    assert.equal(h.dom.captureSave.disabled, false);
    await saveOnce(h);
    assert.equal(h.dom.captureNotice.textContent, 'extension.captureSavedTo{"book":"Book"}', '成功提示必須指明收藏到哪一本詞書');
    assert.equal(h.dom.captureSave.textContent, 'extension.captureSaved');
    assert.equal(h.dom.captureSave.disabled, true, '已加入後同一個結果不得再按一次');
    assert.equal(h.dom.capturePending.hidden, true);
});

test('收藏離線：必須明說已保留待傳，不得顯示已加入，且要能再試', async (t) => {
    const h = await build(t);
    await h.ui.sync();
    showWord(h.ui);
    const clicking = h.dom.captureSave.click();
    await tick();
    h.client.resolve('enqueue');
    await tick();
    h.client.pendingItems = [{ key: 'k1', payload: { word: 'plunge', bookId: 'book', requestId: 'req-1' } }];
    h.client.reject('send', Object.assign(new Error('offline'), { code: 'capture_pending' }));
    await clicking;
    assert.equal(h.dom.captureNotice.textContent, 'extension.capturePending', '離線時必須明說已保留待傳');
    assert.notEqual(h.dom.captureSave.textContent, 'extension.captureSaved');
    assert.equal(h.dom.captureSave.disabled, false, '失敗後必須能再試');
    assert.equal(h.dom.capturePending.hidden, false, '待傳清單必須出現');
    assert.equal(h.dom.capturePendingSummary.textContent, 'extension.capturePendingCount{"count":1}');
    assert.equal(h.client.calls.enqueue, 1);
});

test('排隊失敗（未產生待傳）不得說成已待傳，要顯示真正的錯誤', async (t) => {
    const h = await build(t);
    await h.ui.sync();
    showWord(h.ui);
    const clicking = h.dom.captureSave.click();
    await tick();
    h.client.reject('enqueue', Object.assign(new Error('quota'), { code: 'capture_storage_failed' }));
    await clicking;
    assert.equal(h.dom.captureNotice.textContent, 'extension.captureStorageFailed');
    assert.equal(h.dom.capturePending.hidden, true, '沒有待傳就不該顯示待傳清單');
    assert.equal(h.dom.captureSave.disabled, false);
    assert.equal(h.client.calls.send, 0, '沒有耐久保存就不得送出');
});

test('每個 client 錯誤碼都要顯示對應訊息，且不得看起來像已加入', async (t) => {
    const cases = [
        ['capture_target_missing', 'extension.captureTargetMissing'],
        ['capture_sources_full', 'extension.captureSourcesFull'],
        ['capture_outbox_full', 'extension.captureOutboxFull'],
        ['capture_storage_failed', 'extension.captureStorageFailed'],
        ['capture_server_update_required', 'extension.captureServerUpdateRequired'],
        ['capture_request_mismatch', 'extension.captureRequestMismatch'],
        ['capture_revision_conflict', 'extension.captureRetryLater'],
        ['capture_invalid_input', 'extension.captureInvalidInput'],
        ['capture_invalid_record', 'extension.captureInvalidPending'],
        ['rate_limited', 'extension.captureRateLimited'],
        ['unauthorized', 'extension.captureLoginRequired'],
        ['stale_session', 'extension.captureLoginRequired']
    ];
    const moduleUrl = buildHarnessModule(t);
    for (const [code, key] of cases) {
        const h = await build(t, { moduleUrl });
        await h.ui.sync();
        showWord(h.ui);
        const clicking = h.dom.captureSave.click();
        await tick();
        h.client.reject('enqueue', Object.assign(new Error(code), { code }));
        await clicking;
        assert.equal(h.dom.captureNotice.textContent, key, `${code} 應顯示 ${key}`);
        assert.notEqual(h.dom.captureSave.textContent, 'extension.captureSaved');
        assert.equal(h.dom.captureSave.disabled, false, `${code} 之後必須能再試`);
    }
});

test('詞書載入失敗但有快取：提示離線，舊快取不得當成明確預設，需使用者自己選', async (t) => {
    const moduleUrl = buildHarnessModule(t);
    const h = await build(t, {
        moduleUrl,
        booksError: Object.assign(new Error('offline'), { code: 'sync_unreachable', status: 0 })
    });
    const cacheKey = `bdc_capture_books_v1:${captureScopeKey(loggedIn)}`;
    // 舊版快取沒有 selectionPolicy：其中的 defaultBookId 不可信。
    h.storage.values[cacheKey] = { books: [{ id: 'cached', name: 'Cached' }], defaultBookId: 'cached' };
    await h.ui.sync();
    await tick();
    assert.equal(h.dom.captureNotice.textContent, 'extension.captureBooksOffline');
    assert.equal(h.dom.captureBook.value, '', '離線舊快取不得被當成既有明確預設');
    showWord(h.ui);
    assert.equal(h.dom.captureSave.disabled, true, '沒有明確選書就不得收藏');
    h.dom.captureBook.value = 'cached';
    for (const handler of h.dom.captureBook.listeners.get('change') || []) handler();
    assert.equal(h.dom.captureSave.disabled, false, '離線時選好快取詞書仍可收藏');
});

test('標記 explicit-v1 的快取可沿用明確選擇', async (t) => {
    const moduleUrl = buildHarnessModule(t);
    const h = await build(t, {
        moduleUrl,
        booksError: Object.assign(new Error('offline'), { code: 'sync_unreachable', status: 0 })
    });
    const cacheKey = `bdc_capture_books_v1:${captureScopeKey(loggedIn)}`;
    h.storage.values[cacheKey] = {
        books: [{ id: 'cached', name: 'Cached' }], defaultBookId: 'cached', selectionPolicy: 'explicit-v1'
    };
    await h.ui.sync();
    await tick();
    assert.equal(h.dom.captureBook.value, 'cached', '明確政策下的快取預設仍要沿用');
    showWord(h.ui);
    assert.equal(h.dom.captureSave.disabled, false);
});

// ── 2. 競態 ────────────────────────────────────────────────────────────────

test('收藏途中切換目標詞書：結束後按鈕必須恢復可用，且提示指明原詞書', async (t) => {
    const h = await build(t, {
        booksResult: { books: [{ id: 'book', name: 'Book' }, { id: 'book2', name: 'Book 2' }], defaultBookId: 'book' }
    });
    await h.ui.sync();
    showWord(h.ui);
    const clicking = h.dom.captureSave.click();
    await tick();
    h.client.resolve('enqueue');
    await tick();
    h.dom.captureBook.value = 'book2';
    for (const handler of h.dom.captureBook.listeners.get('change') || []) handler();
    await tick();
    h.client.resolve('send');
    await clicking;
    await tick();
    assert.equal(h.dom.captureSave.disabled, false, '收藏結束後按鈕必須恢復可用（不得卡在「正在加入…」）');
    assert.equal(h.dom.captureSave.textContent, 'extension.captureSave', '切換後的新詞書其實還沒收藏');
    assert.equal(h.dom.captureNotice.textContent, 'extension.captureSavedTo{"book":"Book"}',
        '成功提示必須說明加入的是原詞書，不是切換後的詞書');
});

test('收藏途中換詞書：新詞書不得標成已加入，且可立刻為新詞書再收藏一次', async (t) => {
    const h = await build(t, {
        booksResult: { books: [{ id: 'book', name: 'Book' }, { id: 'book2', name: 'Book 2' }], defaultBookId: 'book' }
    });
    await h.ui.sync();
    showWord(h.ui);
    const clicking = h.dom.captureSave.click();
    await tick();
    h.client.resolve('enqueue');
    await tick();
    h.dom.captureBook.value = 'book2';
    for (const handler of h.dom.captureBook.listeners.get('change') || []) handler();
    await tick();
    h.client.resolve('send');
    await clicking;
    assert.notEqual(h.dom.captureSave.textContent, 'extension.captureSaved', '新詞書其實還沒收藏');
    assert.equal(h.dom.captureNotice.textContent, 'extension.captureSavedTo{"book":"Book"}');

    // 為新詞書再按一次：必須建立新操作（bookId=book2），不得重送舊詞書的操作。
    const second = h.dom.captureSave.click();
    await tick();
    const enqueued = h.client.resolve('enqueue');
    assert.equal(enqueued.value.payload.bookId, 'book2', '換詞書後再收藏必須是新操作');
    await tick();
    h.client.resolve('send');
    await second;
    assert.equal(h.dom.captureNotice.textContent, 'extension.captureSavedTo{"book":"Book 2"}');
});

test('舊收藏的 finally 不得解除新收藏的忙碌狀態（activeSave 令牌）', async (t) => {
    const h = await build(t);
    await h.ui.sync();
    showWord(h.ui);
    const first = h.dom.captureSave.click();
    await tick();
    h.client.resolve('enqueue', undefined);
    await tick();
    // 新的一次查詞：允許立刻再收藏，於是兩個 attempt 會重疊
    h.ui.clearResult();
    showWord(h.ui, { result: { text: 'rise', meaning: '上升' } });
    const second = h.dom.captureSave.click();
    await tick();
    h.client.resolve('send');            // 舊 attempt 先完成
    await first;
    await tick();
    assert.equal(h.dom.captureSave.textContent, 'extension.captureSaving', '舊 attempt 不得解除新 attempt 的忙碌狀態');
    assert.equal(h.dom.captureSave.disabled, true);
    assert.equal(h.dom.captureNotice.textContent, '', '已不是目前 attempt，不得搶著顯示成功提示');
    h.client.resolve('enqueue');
    await tick();
    h.client.resolve('send');
    await second;
    assert.equal(h.dom.captureNotice.textContent, 'extension.captureSavedTo{"book":"Book"}', '新 attempt 完成才顯示成功');
    assert.equal(h.dom.captureSave.textContent, 'extension.captureSaved');
});

test('收藏途中重新查詞：新結果不得被標成已收藏', async (t) => {
    const h = await build(t);
    await h.ui.sync();
    showWord(h.ui);
    const clicking = h.dom.captureSave.click();
    await tick();
    h.client.resolve('enqueue');
    await tick();
    h.ui.clearResult();
    showWord(h.ui, { result: { text: 'rise', meaning: '上升' } });
    assert.equal(h.dom.captureSave.disabled, false, '新結果應該可以收藏');
    assert.equal(h.dom.captureSave.textContent, 'extension.captureSave');
    h.client.resolve('send');
    await clicking;
    assert.notEqual(h.dom.captureSave.textContent, 'extension.captureSaved', '新結果不得被標成已收藏');
    assert.notEqual(h.dom.captureNotice.textContent, 'extension.captureSavedTo{"book":"Book"}', '新結果不得收到舊結果的成功提示');
});

test('收藏途中帳戶事件觸發 sync：不得卡在收藏中，舊 attempt 也不得冒出成功提示', async (t) => {
    const h = await build(t);
    await h.ui.sync();
    showWord(h.ui);
    const clicking = h.dom.captureSave.click();
    await tick();
    h.client.resolve('enqueue');
    await tick();
    const syncing = h.ui.sync();
    await tick();
    h.client.resolve('send');
    await clicking;
    await syncing;
    assert.notEqual(h.dom.captureSave.textContent, 'extension.captureSaving');
    assert.equal(h.dom.captureSave.disabled, true, 'sync 後沒有查詞結果，收藏應不可按');
    assert.equal(h.dom.captureNotice.textContent, '', '已被 sync 作廢的舊收藏不得事後顯示成功');
});

// ── 2b. 明確選書（不再猜預設）─────────────────────────────────────────────

test('沒有明確預設：首次必須由使用者選書，選過之後同一頁會記住、換頁不沿用', async (t) => {
    const moduleUrl = buildHarnessModule(t);
    const booksResult = { books: [{ id: 'book', name: 'Book' }, { id: 'book2', name: 'Book 2' }], defaultBookId: '' };
    // 生產順序：面板啟動先 sync()，擷取到來源後才 setSource()。
    const h = await build(t, { moduleUrl, booksResult });
    await h.ui.sync();
    await tick();
    h.ui.setSource({ pageUrl: 'https://news.example/a', pageTitle: 'Stocks plunge' });
    await tick();
    assert.equal(h.dom.captureBook.value, '', '沒有合法預設時必須停在「請選擇詞書」，不可自動挑第一本');
    showWord(h.ui);
    assert.equal(h.dom.captureSave.disabled, true, '沒選詞書就不得收藏');
    h.dom.captureBook.value = 'book2';
    for (const handler of h.dom.captureBook.listeners.get('change') || []) handler();
    assert.equal(h.dom.captureSave.disabled, false, '明確選書後即可收藏');
    await saveOnce(h);
    assert.equal(h.dom.captureNotice.textContent, 'extension.captureSavedTo{"book":"Book 2"}', '成功提示要指明實際的詞書');

    const again = await build(t, { moduleUrl, booksResult, storage: h.storage });
    await again.ui.sync();
    await tick();
    again.ui.setSource({ pageUrl: 'https://news.example/a', pageTitle: 'Stocks plunge' });
    await tick();
    assert.equal(again.dom.captureBook.value, 'book2', '同一頁的明確選擇必須被記住');

    const otherPage = await build(t, { moduleUrl, booksResult, storage: h.storage });
    await otherPage.ui.sync();
    await tick();
    otherPage.ui.setSource({ pageUrl: 'https://news.example/b', pageTitle: 'Another page' });
    await tick();
    assert.equal(otherPage.dom.captureBook.value, '', '換頁面不得沿用上一頁的選擇');
});

// ── 3. 待傳清單 ────────────────────────────────────────────────────────────

test('待傳清單：顯示詞書名稱，可逐筆取消，取消後清單消失', async (t) => {
    const operation = { key: 'bdc_capture_outbox_v1:x:req-9', payload: { word: 'plunge', bookId: 'book', requestId: 'req-9' } };
    const h = await build(t, { pending: [operation] });
    await h.ui.sync();
    assert.equal(h.dom.capturePending.hidden, false);
    const [item] = h.dom.capturePendingList.children;
    const label = item.children.find((child) => child.tagName === 'SPAN');
    assert.equal(label.textContent, 'plunge · Book');
    const actions = item.children.find((child) => child.className === 'ext-row');
    const [retryButton, cancelButton] = actions.children;
    assert.equal(retryButton.textContent, 'extension.captureRetry');
    assert.equal(cancelButton.textContent, 'extension.captureCancel');
    h.client.pendingItems = [];
    cancelButton.listeners.get('click')[0]();
    await tick();
    h.client.resolve('cancel');
    await tick();
    await tick();
    assert.equal(h.client.calls.cancel, 1);
    assert.equal(h.dom.capturePending.hidden, true, '取消後清單應消失');
});

test('待傳清單：損壞記錄要顯示成損壞、只能取消不能重試，且不顯示 foreign 字詞', async (t) => {
    const good = { key: 'bdc_capture_outbox_v1:x:req-1', payload: { word: 'plunge', bookId: 'book', requestId: 'req-1' } };
    // capture-client 對 foreign／損壞記錄會把字詞與詞書清空，UI 不得自行補回任何內容。
    const broken = { key: 'bdc_capture_outbox_v1:x:req-2', payload: { requestId: 'req-2', word: '', bookId: 'book' }, invalid: true };
    const h = await build(t, { pending: [good, broken] });
    await h.ui.sync();
    assert.equal(h.dom.capturePending.hidden, false);
    const items = h.dom.capturePendingList.children;
    assert.equal(items.length, 2, '壞記錄不得被藏起來');
    const brokenItem = items[1];
    const label = brokenItem.children.find((child) => child.tagName === 'SPAN');
    assert.equal(label.textContent, 'extension.captureInvalidPending · Book', '壞記錄要用「已損壞」文案，不可顯示 foreign 字詞');
    assert.ok(!label.textContent.includes('Foreign'));
    const status = brokenItem.children.find((child) => child.tagName === 'P');
    assert.equal(status.textContent, 'extension.captureInvalidPending');
    const actions = brokenItem.children.find((child) => child.className === 'ext-row');
    assert.equal(actions.children.length, 1, '損壞記錄不得提供重試（重試一定失敗）');
    assert.equal(actions.children[0].textContent, 'extension.captureCancel');
    const goodActions = items[0].children.find((child) => child.className === 'ext-row');
    assert.equal(goodActions.children.length, 2, '健康記錄仍要能重試與取消');

    h.client.pendingItems = [good];
    actions.children[0].listeners.get('click')[0]();
    await tick();
    h.client.resolve('cancel');
    await tick();
    await tick();
    assert.equal(h.client.calls.cancel, 1);
    assert.equal(h.dom.capturePendingList.children.length, 1, '取消壞記錄後只剩健康的那筆');
    assert.equal(h.dom.capturePending.hidden, false);
});

test('待傳清單的單筆重試：成功後清單消失並顯示已加入', async (t) => {
    const operation = { key: 'bdc_capture_outbox_v1:x:req-9', payload: { word: 'plunge', bookId: 'book', requestId: 'req-9' } };
    const h = await build(t, { pending: [operation] });
    await h.ui.sync();
    showWord(h.ui);
    const [item] = h.dom.capturePendingList.children;
    const retryButton = item.children.find((child) => child.className === 'ext-row').children[0];
    h.client.pendingItems = [];
    retryButton.listeners.get('click')[0]();
    await tick();
    h.client.resolve('send');
    await tick();
    await tick();
    assert.equal(h.dom.captureNotice.textContent, 'extension.captureSaved');
    assert.equal(h.dom.capturePending.hidden, true);
});

test('批次重試：失敗保留待傳並顯示對應錯誤，成功則清單消失', async (t) => {
    const operation = { key: 'k1', payload: { word: 'plunge', bookId: 'book', requestId: 'req-1' } };
    const h = await build(t, { pending: [operation] });
    h.client.retryResults = [{ operation, error: 'capture_sources_full' }];
    await h.ui.sync();
    await tick();
    assert.equal(h.dom.capturePending.hidden, false, '失敗後待傳必須保留顯示');
    assert.equal(h.dom.captureNotice.textContent, 'extension.captureSourcesFull');

    h.client.retryResults = [{ operation, receipt: { entryId: 'entry-1', revision: 1 } }];
    h.client.pendingItems = [];
    await h.ui.sync();
    await tick();
    assert.equal(h.dom.capturePending.hidden, true);
    assert.equal(h.client.calls.retry, 2);
});

// ── 4. 來源顯示與 i18n ─────────────────────────────────────────────────────

test('來源列只顯示合法網址；沒有來源時明說是手動查詞', async (t) => {
    const h = await build(t);
    await h.ui.sync();
    h.ui.setSource(null);
    assert.equal(h.dom.captureSource.textContent, 'extension.captureManualSource');
    h.ui.setSource({ pageUrl: 'https://news.example/a', pageTitle: 'Stocks plunge' });
    assert.equal(h.dom.captureSource.children[0].tagName, 'A');
    assert.equal(h.dom.captureSource.children[0].textContent, 'Stocks plunge');
    assert.equal(h.dom.captureSource.children[0].rel, 'noopener noreferrer');
    h.ui.setSource({ pageUrl: 'javascript:alert(1)', pageTitle: 'x' });
    assert.equal(h.dom.captureSource.textContent, 'extension.captureManualSource', '非 http(s) 來源不得顯示成連結');
});

test('所有用到的翻譯鍵都同時存在於 extension 兩語詞典', async () => {
    const source = readFileSync(join(here, 'extension/capture-ui.js'), 'utf8');
    const keys = [...new Set([...source.matchAll(/'extension\.(capture[A-Za-z]+)'/g)].map((match) => match[1]))];
    assert.ok(keys.length >= 20, `應抓到 capture 系列鍵，實際 ${keys.length}`);
    const zhCN = (await import('../extension/locales/zh-CN.js')).default;
    const zhHK = (await import('../extension/locales/zh-HK.js')).default;
    const missing = [];
    for (const key of keys) {
        if (typeof zhCN.extension?.[key] !== 'string') missing.push(`zh-CN:${key}`);
        if (typeof zhHK.extension?.[key] !== 'string') missing.push(`zh-HK:${key}`);
    }
    assert.deepEqual(missing, []);
    assert.deepEqual(Object.keys(zhCN.extension).sort(), Object.keys(zhHK.extension).sort(), '兩語 extension 鍵集合必須一致');
    const html = readFileSync(join(here, 'extension/lookup.html'), 'utf8');
    for (const [, key] of html.matchAll(/data-i18n="extension\.(capture[A-Za-z]+)"/g)) {
        assert.ok(typeof zhCN.extension?.[key] === 'string', `lookup.html 的 ${key} 缺 zh-CN`);
        assert.ok(typeof zhHK.extension?.[key] === 'string', `lookup.html 的 ${key} 缺 zh-HK`);
    }
});

test('lookup.html 具備 capture-ui.js 需要的所有 id，且 lookup.js 有對應的 dom 參照', () => {
    const html = readFileSync(join(here, 'extension/lookup.html'), 'utf8');
    const script = readFileSync(join(here, 'extension/lookup.js'), 'utf8');
    for (const id of [
        'ext-capture-book', 'ext-capture-save', 'ext-capture-refresh', 'ext-capture-source',
        'ext-capture-notice', 'ext-capture-pending', 'ext-capture-pending-summary', 'ext-capture-pending-list'
    ]) {
        assert.ok(html.includes(`id="${id}"`), `lookup.html 缺少 ${id}`);
        assert.ok(script.includes(`'${id}'`), `lookup.js 沒有參照 ${id}`);
    }
    for (const name of ['captureBook', 'captureSave', 'captureRefresh', 'captureSource', 'captureNotice', 'capturePending', 'capturePendingSummary', 'capturePendingList']) {
        assert.ok(readFileSync(join(here, 'extension/capture-ui.js'), 'utf8').includes(`dom.${name}`), `capture-ui.js 未使用 dom.${name}`);
        assert.ok(script.includes(`${name}: document.getElementById`), `lookup.js 的 dom 缺 ${name}`);
    }
});
