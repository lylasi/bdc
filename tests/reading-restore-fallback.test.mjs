// 第十六輪 R2／P3：localStorage 後備模式的還原核對與訪客併入。
//
// R2：`writeEntityFallback()` 成功後只呼叫 `rememberEntity()`，不像
// `rememberAppliedEntity()` 會讓 `messagesByConversation` 失效。還原到空會話
// 時，寫入前 `getMessages()` 已快取空陣列，後續核對仍讀到空陣列，成功寫入的
// `allowPartial:true` 還原被誤判成 `partial_restore_failed`。
//
// P3：`adoptGuestReadingData()` 未檢查 `exportAll()` 的 `payload.ok` 就讀
// `.length`；訪客匯出失敗時直接拋 `TypeError`，且切回目前 scope 只能靠單一路徑
// 執行。這裡驗證失敗時回 `ok:false`、不拋錯、`getReadingScope()` 已恢復。
//
// 刻意不提供 IndexedDB：閱讀 store 走 localStorage 後備，才能重現上述路徑。
//
// Usage: node --test --test-timeout=120000 tests/reading-restore-fallback.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

const storage = new Map();
const localStorageShim = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)); },
    removeItem: (key) => { storage.delete(key); },
    key: (index) => [...storage.keys()][index] ?? null,
    get length() { return storage.size; }
};

class StubEmitter {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, callback) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(callback);
    }
    removeEventListener(type, callback) {
        const set = this.listeners.get(type);
        if (set) set.delete(callback);
    }
    dispatchEvent(event) {
        const set = this.listeners.get(event && event.type);
        if (set) for (const callback of [...set]) callback(event);
        return true;
    }
}

globalThis.CustomEvent = class CustomEvent {
    constructor(type, init = {}) {
        this.type = type;
        this.detail = init && init.detail;
    }
};
const win = new StubEmitter();
win.localStorage = localStorageShim;
globalThis.window = win;
const doc = new StubEmitter();
doc.hidden = false;
globalThis.document = doc;
globalThis.localStorage = localStorageShim;
globalThis.Audio = class {
    play() { return Promise.resolve(); }
    pause() {}
    addEventListener() {}
    removeEventListener() {}
};
globalThis.indexedDB = undefined;
globalThis.__BDC_SYNC_ENDPOINT__ = 'https://worker.mock';
globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });

const articleStore = await import('../modules/article-store.js');
const readingStore = await import('../modules/reading-store.js');

const ENDPOINT = 'https://worker.mock';
const USER = 'restore-fallback-user';
const SCOPE = `${ENDPOINT}::${USER}`;
const GUEST_SCOPE = `${ENDPOINT}::guest`;
const ARTICLE_ID = 'fallback-restore-article';
const READING_BUCKET_KEY = `bdc:reading:fallback:v1:${SCOPE}`;
const GUEST_BUCKET_KEY = `bdc:reading:fallback:v1:${GUEST_SCOPE}`;

/** 後備模式的「清空 scope」：直接移除 bucket 再重新載入記憶體視圖。 */
async function emptyScope(target = SCOPE) {
    localStorage.removeItem(`bdc:reading:fallback:v1:${target}`);
    const init = await readingStore.initReadingStore(target);
    assert.equal(init.ok, true, JSON.stringify(init));
    assert.equal(init.fallbackMode, true, '測試前提：閱讀 store 必須在後備模式');
}

async function seedScope(target = SCOPE, user = USER) {
    if (user) {
        localStorage.setItem('sync_token', 'test-token');
        localStorage.setItem('sync_user_id', user);
    }
    const articleInit = await articleStore.initArticleStore();
    assert.equal(articleInit.fallbackMode, true, '測試前提：文章 store 必須在後備模式');
    if (!articleStore.getRecord(ARTICLE_ID)) {
        const saved = await articleStore.saveArticle({
            articleId: ARTICLE_ID,
            title: ARTICLE_ID,
            article: `body for ${ARTICLE_ID}`,
            sourceType: 'paste'
        });
        assert.equal(saved.ok, true, JSON.stringify(saved));
    }
    const init = await readingStore.initReadingStore(target);
    assert.equal(init.ok, true, JSON.stringify(init));
    assert.equal(init.fallbackMode, true, '測試前提：閱讀 store 必須在後備模式');
}

async function seedConversationWithMessage(content = '後備模式問題') {
    const conv = await readingStore.ensureConversation({ articleId: ARTICLE_ID, title: '後備會話' });
    assert.equal(conv.ok, true, JSON.stringify(conv));
    const message = await readingStore.appendMessage({
        conversationId: conv.conversation.id,
        role: 'user',
        content
    });
    assert.equal(message.ok, true, JSON.stringify(message));
    return { conversation: conv.conversation, message: message.message };
}

test('後備模式還原消息：首次與重複還原都回 ok:true 且 verifyErrors 為空', async () => {
    await seedScope();
    await emptyScope();
    const { conversation, message } = await seedConversationWithMessage();
    const payload = await readingStore.exportAll();
    assert.equal(payload.ok, true, JSON.stringify(payload));
    assert.equal(payload.messages.length, 1);

    // 重新載入目前 scope 的記憶體視圖與消息快取（不呼叫後備模式的
    // clearScopeForTests：它讀不到 IndexedDB，不會清掉 bucket）。
    await emptyScope();
    assert.deepEqual(await readingStore.getMessages(conversation.id), []);

    const first = await readingStore.restoreAll(payload, { allowPartial: true });
    assert.equal(first.ok, true, `後備模式首次還原被誤判失敗：${JSON.stringify(first)}`);
    assert.deepEqual(first.verifyErrors, []);
    assert.equal(first.counts.messages, 1);
    assert.deepEqual((await readingStore.getMessages(conversation.id)).map((item) => item.id), [message.id]);

    // 重複還原同一份備份必須冪等，且快取已同步，不得再次誤判。
    const second = await readingStore.restoreAll(payload, { allowPartial: true });
    assert.equal(second.ok, true, `後備模式重複還原被誤判失敗：${JSON.stringify(second)}`);
    assert.deepEqual(second.verifyErrors, []);
    assert.equal(second.counts.messages, 1);
    assert.deepEqual((await readingStore.getMessages(conversation.id)).map((item) => item.id), [message.id]);

    // 後備 bucket 真的留下消息（不是只通過核對）。
    const bucket = JSON.parse(localStorage.getItem(READING_BUCKET_KEY) || '{}');
    assert.equal((bucket.messages || []).length, 1, JSON.stringify(bucket.messages));
});

test('訪客 exportAll 失敗：adoptGuestReadingData 回 ok:false、不拋錯、scope 已恢復', async () => {
    await seedScope();
    await emptyScope();
    // 訪客 bucket 損壞：`exportAll()` 嚴格讀取必須回 `storage_corrupt`。
    localStorage.setItem(GUEST_BUCKET_KEY, '{"messages":[');
    assert.equal(readingStore.getReadingScope(), SCOPE);

    let result;
    await assert.doesNotReject(async () => {
        result = await readingStore.adoptGuestReadingData();
    }, '訪客匯出失敗時 adoptGuestReadingData 不得拋錯（原本會 TypeError）');
    assert.ok(result, 'adoptGuestReadingData 沒有回傳結果');
    assert.equal(result.ok, false, `訪客匯出失敗仍回報成功：${JSON.stringify(result)}`);
    assert.equal(result.error, 'storage_corrupt');
    assert.equal(result.imported, undefined, '失敗結果不應帶 imported 計數');
    // 無論成敗都必須切回目前 scope。
    assert.equal(readingStore.getReadingScope(), SCOPE, '訪客匯出失敗後 scope 未恢復');
});

test('訪客併入成功（反向驗證）：匯出正常時仍可併入並切回目前 scope', async () => {
    await seedScope();
    await emptyScope();
    // 以訪客身分寫入一筆詞書（詞書不需要文章）。
    await emptyScope(GUEST_SCOPE);
    const saved = await readingStore.upsertVocabularyBook({ id: 'guest-fallback-book', name: '訪客後備詞書' });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    await emptyScope();

    const result = await readingStore.adoptGuestReadingData();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.imported, 1);
    assert.equal(readingStore.getReadingScope(), SCOPE);
    assert.equal(readingStore.getVocabularyBook('guest-fallback-book')?.name, '訪客後備詞書');
});
