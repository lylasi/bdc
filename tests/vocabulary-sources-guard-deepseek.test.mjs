// DeepSeek 獨立補測（P2-5）：來源上限在主站／協議層的契約。
//
// 這一輪修復把「不能靜默裁切」補到主站路徑，本檔釘住四件事：
//   1. `normalizeReadingPatch` 不得再 slice 來源：101 筆要完整留在資料表示裡。
//   2. 但 `validateReadingMutation` 必須明確拒絕 >100（vocabulary_sources_full），
//      而不是裁切成 100 送出去。
//   3. 主站本機寫入也要明確：`upsertVocabularyEntry()` 與
//      `addVocabularyEntryWithLink()` 交易內合併超量時回 `vocabulary_sources_full`，
//      且不得留下半套資料（記憶體視圖、IndexedDB、outbox 都不變）。
//   4. 合併去重鍵要含「當次意思」：同網址／同句／同錨點的另一個意思不得被吃掉。
//
// 用 fake IndexedDB 跑真正的 `modules/reading-store.js`（不是複刻邏輯）。
//
// Usage: node --test tests/vocabulary-sources-guard-deepseek.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createFakeIndexedDB } from './helpers/fake-indexeddb.mjs';

const here = fileURLToPath(new URL('..', import.meta.url));

// ── 瀏覽器環境 shim（只放 reading-store 真正會用到的東西）──────────────────
const storage = new Map();
const localStorageShim = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)); },
    removeItem: (key) => { storage.delete(key); },
    key: (index) => [...storage.keys()][index] || null,
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
globalThis.indexedDB = createFakeIndexedDB();
globalThis.__BDC_SYNC_ENDPOINT__ = 'https://worker.mock';
globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });

const articleStore = await import('../modules/article-store.js');
const readingStore = await import('../modules/reading-store.js');
const { normalizeReadingPatch, validateReadingMutation } = await import('../shared/reading-protocol.mjs');

const ENDPOINT = 'https://worker.mock';
const USER = 'sources-guard-user';
const SCOPE = `${ENDPOINT}::${USER}`;

async function seedScope() {
    localStorage.setItem('sync_token', 'test-token');
    localStorage.setItem('sync_user_id', USER);
    await articleStore.reloadScope(SCOPE);
    const init = await readingStore.initReadingStore(SCOPE);
    assert.equal(init.ok, true, JSON.stringify(init));
}

async function resetStore() {
    await seedScope();
    await readingStore.clearScopeForTests();
    await seedScope();
}

const source = (index, meaning = '暴跌') => ({
    sourceUrl: `https://news.example/${index}`,
    pageTitle: 'Stocks plunge',
    sentence: 'Major tech stocks plunge.',
    context: 'Major tech stocks plunge. Markets are volatile.',
    meaning,
    anchor: { start: 18, end: 24, quote: 'plunge' }
});

const manySources = (count, meaning = '暴跌') => Array.from({ length: count }, (_, i) => source(i, meaning));

async function book() {
    const result = await readingStore.upsertVocabularyBook({ id: 'book', name: '单词本', sourceType: 'manual' });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.entity;
}

// ── 1. 協議層：不裁切，但要明確拒絕 ─────────────────────────────────────────

test('normalizeReadingPatch 不再 slice 來源：101 筆完整保留在資料表示裡', () => {
    const patch = normalizeReadingPatch('vocabularyEntry', { sources: manySources(101) });
    assert.equal(patch.sources.length, 101, '正規化不得靜默裁切（會讓第 101 筆在下一次同步無聲消失）');
    assert.equal(patch.sources[100].sourceUrl, 'https://news.example/100');
    assert.equal(patch.sources[0].meaning, '暴跌', '來源要保留當次意思');
    assert.equal(normalizeReadingPatch('vocabularyEntry', { sources: manySources(120) }).sources.length, 120,
        'legacy 超量資料讀進來也不能被裁掉（否則是資料損毀而不是拒絕）');
});

test('validateReadingMutation：來源 101 筆必須明確拒絕，100 筆才放行', () => {
    const mutation = (sources) => ({
        mutationId: 'mut-1', entityType: 'vocabularyEntry', entityId: 'entry-1', op: 'upsert',
        expectedRevision: 0, patch: { word: 'plunge', meaning: '暴跌', sources }
    });
    const tooMany = validateReadingMutation(mutation(manySources(101)));
    assert.equal(tooMany.ok, false);
    assert.equal(tooMany.error, 'vocabulary_sources_full', '超量要明確拒絕，不可裁切後假裝成功');
    const exact = validateReadingMutation(mutation(manySources(100)));
    assert.equal(exact.ok, true, JSON.stringify(exact));
    assert.equal(exact.mutation.patch.sources.length, 100);
    const overLegacy = validateReadingMutation(mutation(manySources(120)));
    assert.equal(overLegacy.ok, false, 'legacy 超量也不得被裁成 100 送出');
    assert.equal(overLegacy.error, 'vocabulary_sources_full');
});

// ── 2. 主站寫入：明確失敗且不留半套 ─────────────────────────────────────────

test('upsertVocabularyEntry 帶 101 筆來源：回 vocabulary_sources_full，且不寫入、不排隊', async () => {
    await resetStore();
    const created = await book();
    assert.equal(created.id, 'book');
    const outboxBefore = await readingStore.countOutbox();
    const result = await readingStore.upsertVocabularyEntry({
        id: 'entry-full', bookId: 'book', word: 'plunge', meaning: '暴跌', sources: manySources(101)
    });
    assert.equal(result.ok, false, '101 筆不得寫入');
    assert.equal(result.error, 'vocabulary_sources_full', '要把「滿了」明確告訴呼叫端，才不會誤報成功');
    assert.equal(readingStore.getVocabularyEntry('entry-full'), null, '不得留下半套詞條');
    assert.equal(await readingStore.countOutbox(), outboxBefore, '不得排出會把 101 筆送上雲端的 mutation');
});

test('addVocabularyEntryWithLink 交易內合併超量：回 vocabulary_sources_full，既有 99 筆與 outbox 都不變', async () => {
    await resetStore();
    await book();
    const seeded = await readingStore.upsertVocabularyEntry({
        id: 'entry-99', bookId: 'book', word: 'plunge', meaning: '暴跌', phonetic: 'plʌndʒ', pos: 'verb',
        sources: manySources(99)
    });
    assert.equal(seeded.ok, true, JSON.stringify(seeded));
    assert.equal(seeded.entity.sources.length, 99);
    const outboxBefore = await readingStore.countOutbox();
    const before = JSON.stringify(readingStore.getVocabularyEntry('entry-99').sources);

    const result = await readingStore.addVocabularyEntryWithLink({
        book: { id: 'book', name: '单词本' },
        entry: { id: 'entry-99', bookId: 'book', word: 'plunge', meaning: '暴跌', sources: [source(200), source(201)] }
    });
    assert.equal(result.ok, false, '失敗結果不得帶 ok:true');
    assert.equal(result.error, 'vocabulary_sources_full');
    assert.equal(readingStore.getVocabularyEntry('entry-99').sources.length, 99, '合併失敗不得寫入部分來源');
    assert.equal(JSON.stringify(readingStore.getVocabularyEntry('entry-99').sources), before, '既有來源一字不改');
    assert.equal(await readingStore.countOutbox(), outboxBefore, '失敗不得留下 outbox mutation');
});

test('addVocabularyEntryWithLink 合併到剛好 100 筆：成功且 outbox 帶完整來源', async () => {
    await resetStore();
    await book();
    const seeded = await readingStore.upsertVocabularyEntry({
        id: 'entry-99b', bookId: 'book', word: 'plunge', meaning: '暴跌', sources: manySources(99)
    });
    assert.equal(seeded.ok, true, JSON.stringify(seeded));
    const result = await readingStore.addVocabularyEntryWithLink({
        book: { id: 'book', name: '单词本' },
        entry: { id: 'entry-99b', bookId: 'book', word: 'plunge', meaning: '暴跌', sources: [source(300)] }
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.entry.sources.length, 100, '99 + 1 應該剛好滿上限並成功');
    assert.equal(readingStore.getVocabularyEntry('entry-99b').sources.length, 100);
    const outbox = (await readingStore.listOutbox()).find((record) => record.entityId === 'entry-99b');
    assert.ok(outbox, '必須排出同步 mutation');
    assert.equal(outbox.patch.sources.length, 100, '送上雲端的 patch 也必須是完整 100 筆（不得被裁切）');
    assert.equal(outbox.patch.sources[99].sourceUrl, 'https://news.example/300');
});

test('合併去重鍵含「當次意思」：同網址／同句／同錨點的另一個意思不會被吃掉', async () => {
    await resetStore();
    await book();
    const first = await readingStore.upsertVocabularyEntry({
        id: 'entry-sense', bookId: 'book', word: 'plunge', meaning: '暴跌', sources: [source(1, '暴跌')]
    });
    assert.equal(first.ok, true, JSON.stringify(first));
    // 用已保存來源的形狀當基底，讓「意思」成為唯一差異（避免其他欄位不同而假通過）。
    const stored = readingStore.getVocabularyEntry('entry-sense').sources[0];
    const otherSense = { ...stored, meaning: '突然下跌' };
    const second = await readingStore.addVocabularyEntryWithLink({
        book: { id: 'book', name: '单词本' },
        entry: { id: 'entry-sense', bookId: 'book', word: 'plunge', meaning: '暴跌', sources: [otherSense] }
    });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.deepEqual(second.entry.sources.map((item) => item.meaning), ['暴跌', '突然下跌'], '不同意思必須是不同來源');
    assert.equal(second.entry.meaning, '暴跌', '詞條既有意思不得被來源的意思蓋掉');

    // 完全相同的來源仍要去重（不然每點一次就長一筆）。
    const third = await readingStore.addVocabularyEntryWithLink({
        book: { id: 'book', name: '单词本' },
        entry: { id: 'entry-sense', bookId: 'book', word: 'plunge', meaning: '暴跌', sources: [{ ...otherSense }] }
    });
    assert.equal(third.ok, true, JSON.stringify(third));
    assert.equal(third.entry.sources.length, 2, '相同意思的同位置來源仍需去重');
    const sameContent = { ...readingStore.getVocabularyEntry('entry-sense').sources[0] };
    const fourth = await readingStore.addVocabularyEntryWithLink({
        book: { id: 'book', name: '单词本' },
        entry: { id: 'entry-sense', bookId: 'book', word: 'plunge', meaning: '暴跌', sources: [sameContent] }
    });
    assert.equal(fourth.ok, true, JSON.stringify(fourth));
    assert.equal(fourth.entry.sources.length, 2, '逐欄相同的來源不得重複追加');
});

// ── 3. UI 文案：超限提示雙語齊備，且不會誤報成功 ────────────────────────────

test('來源上限的雙語提示存在，且 vocab 走的是「回 ok:false + 提示」而不是假成功', async () => {
    const zhCN = (await import('../locales/zh-CN.js')).default;
    const zhHK = (await import('../locales/zh-HK.js')).default;
    for (const dict of [zhCN, zhHK]) {
        assert.equal(typeof dict.vocabulary?.sourcesLimitReached, 'string', '兩語都要有來源上限文案');
        assert.equal(typeof dict.vocabulary?.savedSources, 'string');
        assert.equal(typeof dict.vocabulary?.sourceMeaning, 'string');
    }
    const vocabSource = readFileSync(new URL('modules/vocab.js', 'file:' + here), 'utf8');
    assert.ok(vocabSource.includes("error: 'vocabulary_sources_full'"), 'vocab.js 必須把上限回報成明確錯誤碼');
    assert.ok(/return \{ ok: false, reason: 'sources_full', error: 'vocabulary_sources_full' \}/.test(vocabSource),
        '追加來源超限時必須回 ok:false，不得繼續寫入或回報成功');
    assert.ok(vocabSource.includes("t('vocabulary.sourcesLimitReached')"), '錯誤要翻成使用者看得懂的雙語提示');
    const statusSource = readFileSync(new URL('features/sync/sync-status.js', 'file:' + here), 'utf8');
    assert.ok(statusSource.includes('vocabulary_sources_full'), '同步狀態也要辨識這個錯誤碼');
});
