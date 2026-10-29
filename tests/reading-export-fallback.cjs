/**
 * 單篇閱讀快照的 localStorage 後備／IDB 隔離回歸（真實 Chromium）。
 *
 * 用法：PORT=8327 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/reading-export-fallback.cjs
 * 使用既有伺服器；不啟動服務、不讀取私人 AI 設定。
 * 伺服器不可用時加 WORKSPACE_ROUTES=1，由 Playwright 回應工作區靜態檔案。
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const WORKSPACE = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: CHROME });
    const results = [];
    try {
        for (const fallback of [true, false]) {
            const context = await browser.newContext();
            try {
                await context.route('**/*', route => {
                    const url = new URL(route.request().url());
                    if (url.pathname.endsWith('/ai-config.js')) {
                        return route.fulfill({ contentType: 'application/javascript', body: 'export const SYNC={endpoint: ""}; export const TTS_CONFIG={}, AI_LIMITS={}, OCR_CONFIG={}, ARTICLE_IMPORT={}, SUPABASE={};' });
                    }
                    if (url.origin !== BASE) return route.abort();
                    if (process.env.WORKSPACE_ROUTES === '1') {
                        const filename = path.resolve(WORKSPACE, `.${decodeURIComponent(url.pathname)}`);
                        if (!filename.startsWith(WORKSPACE + path.sep)) return route.abort();
                        const contentType = { '.js': 'application/javascript', '.mjs': 'application/javascript', '.html': 'text/html', '.json': 'application/json' }[path.extname(filename)];
                        return route.fulfill({ path: filename, ...(contentType ? { contentType } : {}) });
                    }
                    return route.continue();
                });
                if (fallback) {
                    await context.addInitScript(() => {
                        window.readingExportNativeIndexedDb = window.indexedDB;
                        Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
                    });
                }
                const page = await context.newPage();
                await page.goto(`${BASE}/test-reading-blank.html`);
                await page.evaluate(async fallback => {
                    const a = await import('/modules/article-store.js');
                    const r = await import('/modules/reading-store.js');
                    const db = await import('/modules/permanent-db.js');
                    const scopeA = 'reading-export-regression::A';
                    const scopeB = 'reading-export-regression::B';
                    const readingKey = scope => `bdc:reading:fallback:v1:${scope}`;
                    const articleKey = scope => `bdc:articles:fallback:v1:${scope}`;
                    const record = (scope, id, extra = {}) => ({ id, scope, key: `${scope}\u0000${id}`, deletedAt: '', ...extra });
                    const fixtures = scope => {
                        const prefix = scope === scopeA ? 'CURRENT' : 'PRIVATE_ACCOUNT_B';
                        const foreignScope = 'reading-export-regression::foreign';
                        const item = (id, articleId, extra = {}) => record(scope, id, {
                            articleId, kind: 'word', contentVersion: 'cv1', anchor: { start: 0, end: 4, quote: 'Word' },
                            note: `${prefix}_NOTE_${id}`, marked: false, ...extra
                        });
                        const message = (id, conversationId, extra = {}) => record(scope, id, {
                            conversationId, key: `${scope}\u0000${conversationId}\u0000${id}`, role: 'user', content: `${prefix}_CHAT_${id}`, ...extra
                        });
                        const bucket = {
                            items: [
                                item('item_a', 'article_a', { marked: true }),
                                item('item_false', 'article_a', { marked: false, understanding: 'understood' }),
                                item('item_legacy', 'article_a', { marked: undefined, understanding: 'needs_review' }),
                                item('item_linked', 'article_a', { marked: undefined }),
                                item('item_unmarked', 'article_a', { marked: undefined }),
                                item('PRIVATE_OTHER_ARTICLE_ITEM', 'article_b'),
                                item('PRIVATE_DELETED_ITEM', 'article_a', { deletedAt: '2026-10-01T00:00:00.000Z' }),
                                record(foreignScope, 'PRIVATE_FOREIGN_SCOPE_ITEM', { articleId: 'article_a', marked: true })
                            ],
                            documents: [
                                record(scope, 'doc_a', { articleId: 'article_a', kind: 'note', content: `${prefix}_DOCUMENT` }),
                                record(scope, 'PRIVATE_OTHER_ARTICLE_DOCUMENT', { articleId: 'article_b', content: 'PRIVATE_OTHER_ARTICLE_DOCUMENT_CONTENT' }),
                                record(scope, 'PRIVATE_DELETED_DOCUMENT', { articleId: 'article_a', content: 'PRIVATE_DELETED_DOCUMENT_CONTENT', deletedAt: '2026-10-01' })
                            ],
                            conversations: [
                                record(scope, 'conv_a', { articleId: 'article_a', title: `${prefix}_CONVERSATION` }),
                                record(scope, 'PRIVATE_OTHER_ARTICLE_CONVERSATION', { articleId: 'article_b' }),
                                record(scope, 'PRIVATE_DELETED_CONVERSATION', { articleId: 'article_a', deletedAt: '2026-10-01' })
                            ],
                            messages: [
                                message('message_a', 'conv_a'),
                                message('PRIVATE_DELETED_MESSAGE', 'conv_a', { deletedAt: '2026-10-01' }),
                                message('PRIVATE_OTHER_ARTICLE_CHAT', 'PRIVATE_OTHER_ARTICLE_CONVERSATION'),
                                message('PRIVATE_DELETED_CONVERSATION_CHAT', 'PRIVATE_DELETED_CONVERSATION'),
                                message('PRIVATE_ORPHAN_CHAT', 'missing_conversation'),
                                record(foreignScope, 'PRIVATE_FOREIGN_MESSAGE', { conversationId: 'conv_a', content: 'PRIVATE_FOREIGN_MESSAGE' })
                            ],
                            books: [
                                record(scope, 'book_a', { name: `${prefix}_BOOK`, articleId: 'article_a' }),
                                record(scope, 'PRIVATE_OTHER_ARTICLE_BOOK', { name: 'PRIVATE_OTHER_ARTICLE_BOOK_NAME', articleId: 'article_b' })
                            ],
                            entries: [
                                record(scope, 'entry_a', {
                                    bookId: 'book_a', word: 'Word', meaning: 'shared definition', sourceArticleId: 'article_b',
                                    context: 'PRIVATE_OTHER_ARTICLE_CONTEXT', sources: [
                                        { articleId: 'article_b', sentence: 'PRIVATE_OTHER_ARTICLE_SOURCE' },
                                        { articleId: 'article_a', sentence: `${prefix}_SOURCE`, contentVersion: 'cv1' }
                                    ]
                                }),
                                record(scope, 'PRIVATE_OTHER_ARTICLE_ENTRY', { bookId: 'PRIVATE_OTHER_ARTICLE_BOOK', word: 'PRIVATE_OTHER_ARTICLE_WORD' })
                            ],
                            links: [
                                record(scope, 'link_a', { itemId: 'item_a', bookId: 'book_a', entryId: 'entry_a' }),
                                record(scope, 'link_false', { itemId: 'item_false', bookId: 'book_a', entryId: 'entry_a' }),
                                record(scope, 'link_legacy', { itemId: 'item_linked', bookId: 'book_a', entryId: 'entry_a' }),
                                record(scope, 'PRIVATE_OTHER_ARTICLE_LINK', { itemId: 'PRIVATE_OTHER_ARTICLE_ITEM', bookId: 'PRIVATE_OTHER_ARTICLE_BOOK', entryId: 'PRIVATE_OTHER_ARTICLE_ENTRY' }),
                                record(scope, 'PRIVATE_REMOVED_LINK', { itemId: 'item_a', bookId: 'PRIVATE_OTHER_ARTICLE_BOOK', entryId: 'PRIVATE_OTHER_ARTICLE_ENTRY', removedAt: '2026-10-01' }),
                                record(scope, 'PRIVATE_DELETED_ITEM_LINK', { itemId: 'PRIVATE_DELETED_ITEM', bookId: 'PRIVATE_OTHER_ARTICLE_BOOK', entryId: 'PRIVATE_OTHER_ARTICLE_ENTRY' })
                            ],
                            outbox: [], versions: [],
                            state: {
                                scope, lastError: '', conflicts: {
                                    'learningItem:item_a': { note: `${prefix}_CONFLICT` },
                                    'learningItem:PRIVATE_OTHER_ARTICLE_ITEM': { note: 'PRIVATE_OTHER_ARTICLE_CONFLICT' }
                                },
                                legacyItemArticles: { article_a: { at: '2026-10-01' }, article_b: { note: 'PRIVATE_OTHER_ARTICLE_MIGRATION' } }
                            }
                        };
                        const articles = {
                            docs: [
                                record(scope, 'article_a', { title: `${prefix}_ARTICLE`, body: `${prefix}_FULL_BODY`, sourceType: 'paste', lastOpenedAt: '2026-10-27T12:34:56.789Z' }),
                                record(scope, 'article_b', { title: 'PRIVATE_OTHER_ARTICLE_TITLE', body: 'PRIVATE_OTHER_ARTICLE_BODY', lastOpenedAt: '2026-10-28T01:00:00.000Z' }),
                                record(foreignScope, 'PRIVATE_FOREIGN_DOC', { title: 'PRIVATE_FOREIGN_TITLE', body: 'PRIVATE_FOREIGN_BODY' })
                            ], outbox: [], state: {
                                scope, lastError: '', conflicts: {
                                    article_a: { body: `${prefix}_ARTICLE_CONFLICT` },
                                    article_b: { body: 'PRIVATE_OTHER_ARTICLE_CONFLICT_BODY' }
                                }
                            }
                        };
                        return { bucket, articles };
                    };
                    for (const scope of [scopeB, scopeA]) {
                        const { bucket, articles } = fixtures(scope);
                        if (fallback) {
                            localStorage.setItem(readingKey(scope), JSON.stringify(bucket));
                            localStorage.setItem(articleKey(scope), JSON.stringify(articles));
                        } else {
                            const stores = {
                                items: db.STORE.READING_ITEMS, documents: db.STORE.ARTICLE_DOCUMENTS,
                                conversations: db.STORE.CONVERSATIONS, messages: db.STORE.MESSAGES,
                                books: db.STORE.VOCAB_BOOKS, entries: db.STORE.VOCAB_ENTRIES, links: db.STORE.VOCAB_LINKS
                            };
                            const operations = articles.docs.map(value => ({ store: db.STORE.DOCS, type: 'put', value }));
                            operations.push({ store: db.STORE.STATE, type: 'put', value: articles.state });
                            operations.push({ store: db.STORE.READING_STATE, type: 'put', value: bucket.state });
                            for (const [name, store] of Object.entries(stores)) {
                                operations.push(...bucket[name].map(value => ({ store, type: 'put', value })));
                            }
                            const result = await db.applyPermanentOperations(operations);
                            if (!result.ok) throw new Error(JSON.stringify(result));
                        }
                    }
                    await a.reloadScope(scopeA);
                    // 真正的冷啟動：IDB 仍有資料、localStorage 沒有後備桶，只讓一個清單交易失敗。
                    const originalTransaction = IDBDatabase.prototype.transaction;
                    let startupFailures = 0;
                    if (!fallback) {
                        IDBDatabase.prototype.transaction = function transaction(names, mode, ...rest) {
                            const stores = typeof names === 'string' ? [names] : Array.from(names);
                            if (mode === 'readonly' && stores.length === 1 && stores[0] === db.STORE.VOCAB_BOOKS && startupFailures === 0) {
                                startupFailures += 1;
                                throw new DOMException('test one-off startup failure', 'UnknownError');
                            }
                            return originalTransaction.call(this, names, mode, ...rest);
                        };
                    }
                    let initialized;
                    try {
                        initialized = await r.initReadingStore(scopeA);
                    } finally {
                        IDBDatabase.prototype.transaction = originalTransaction;
                    }
                    if (initialized.fallbackMode !== fallback) throw new Error(`Unexpected storage mode: ${JSON.stringify(initialized)}`);
                    // 列表只有摘要：匯出必須從持久儲存取回全文與 lastOpenedAt。
                    window.readingExportTest = {
                        a, r, db, scopeA, scopeB, readingKey, articleKey, fallback, record, fixtures, initialized, startupFailures,
                        startupItemCount: r.listLearningItems('article_a').length
                    };
                }, fallback);

                const run = async (name, work) => {
                    try {
                        await work();
                        results.push({ mode: fallback ? 'localStorage' : 'IndexedDB', name, ok: true });
                    } catch (error) {
                        results.push({ mode: fallback ? 'localStorage' : 'IndexedDB', name, ok: false, error: String(error) });
                    }
                };

                await run('cold snapshot contains only the current article, live chat and linked vocabulary', async () => {
                    const data = await page.evaluate(async () => {
                        const { a, r } = window.readingExportTest;
                        const summaryOnly = a.getRecord('article_a')?.summaryOnly;
                        const snapshot = await r.exportArticleReading('article_a');
                        const groups = snapshot.messagesByConversation instanceof Map ? [...snapshot.messagesByConversation.entries()] : null;
                        return { summaryOnly, ...snapshot, groups, text: JSON.stringify({ ...snapshot, groups }) };
                    });
                    assert.equal(data.ok, true, JSON.stringify(data));
                    assert.equal(data.summaryOnly, true);
                    assert.equal(data.articleDoc.body, 'CURRENT_FULL_BODY');
                    assert.equal(data.articleDoc.lastOpenedAt, '2026-10-27T12:34:56.789Z');
                    assert.deepEqual(data.learningItems.map(item => item.id).sort(), ['item_a', 'item_false', 'item_legacy', 'item_linked', 'item_unmarked']);
                    assert.deepEqual(Object.fromEntries(data.learningItems.map(item => [item.id, item.marked])), {
                        item_a: true, item_false: false, item_legacy: true, item_linked: true, item_unmarked: false
                    });
                    assert.deepEqual(data.articleDocuments.map(doc => doc.id), ['doc_a']);
                    assert.deepEqual(data.conversations.map(conv => conv.id), ['conv_a']);
                    assert.deepEqual(data.messages.map(message => message.id), ['message_a']);
                    assert.deepEqual(data.groups, [['conv_a', data.messages]]);
                    assert.equal(data.messages[0].scope, undefined);
                    assert.equal(data.messages[0].key, undefined);
                    assert.deepEqual(data.vocabularyBooks.map(book => book.id), ['book_a']);
                    assert.deepEqual(data.vocabularyEntries.map(entry => entry.id), ['entry_a']);
                    assert.deepEqual(data.vocabularyEntries[0].sources.map(source => source.articleId), ['article_a']);
                    assert.equal(data.vocabularyEntries[0].context, 'CURRENT_SOURCE');
                    assert.equal(data.vocabularyEntries[0].sourceArticleId, 'article_a');
                    assert.deepEqual(data.vocabularyLinks.map(link => link.id).sort(), ['link_a', 'link_false', 'link_legacy']);
                    assert.equal(data.text.includes('PRIVATE_'), false, data.text);
                    assert.deepEqual(Object.keys(data.readingState.conflicts), ['learningItem:item_a']);
                    assert.deepEqual(Object.keys(data.articleState.conflicts), ['article_a']);
                    assert.equal(data.readingOutboxCount, 3);
                });

                if (!fallback) {
                    await run('one failed startup IDB transaction keeps persisted items and notes available to loading and export', async () => {
                        const data = await page.evaluate(async () => {
                            const { r, db, scopeA, readingKey, initialized, startupFailures, startupItemCount } = window.readingExportTest;
                            await r.reloadReadingScope(scopeA);
                            const coldCount = r.listLearningItems('article_a').length;
                            const loaded = await r.ensureArticleReadingLoaded('article_a');
                            const item = r.getLearningItem('item_a');
                            const document = r.getArticleDocument('doc_a');
                            const snapshot = await r.exportArticleReading('article_a');
                            const backup = await r.exportAll(r.captureReadingContext(), { hydrate: false });
                            const persisted = await db.readStoreOne(db.STORE.READING_ITEMS, `${scopeA}\u0000item_legacy`);
                            const outbox = await db.readStoreOne(db.STORE.READING_OUTBOX, `${scopeA}\u0000learningItem\u0000item_legacy`);
                            return {
                                initialized, startupFailures, startupItemCount, coldCount, loaded, item, document, snapshot, backup,
                                persisted: persisted.value, outbox: outbox.value, bucket: localStorage.getItem(readingKey(scopeA))
                            };
                        });
                        assert.equal(data.startupFailures, 1);
                        assert.equal(data.initialized.fallbackMode, false);
                        assert.equal(data.startupItemCount, 0);
                        assert.equal(data.coldCount, 0);
                        assert.equal(data.loaded.ok, true, JSON.stringify(data.loaded));
                        assert.equal(data.item.note, 'CURRENT_NOTE_item_a');
                        assert.equal(data.document.content, 'CURRENT_DOCUMENT');
                        assert.equal(data.snapshot.ok, true, JSON.stringify(data.snapshot));
                        assert.equal(data.snapshot.learningItems.find(item => item.id === 'item_a').note, 'CURRENT_NOTE_item_a');
                        assert.equal(data.snapshot.articleDocuments.find(doc => doc.id === 'doc_a').content, 'CURRENT_DOCUMENT');
                        assert.equal(data.snapshot.articleDoc.body, 'CURRENT_FULL_BODY');
                        assert.equal(data.backup.ok, true, JSON.stringify(data.backup));
                        assert.equal(data.backup.schemaVersion, 1);
                        assert.equal(data.backup.learningItems.find(item => item.id === 'item_a').note, 'CURRENT_NOTE_item_a');
                        assert.equal(data.backup.articleDocuments.find(doc => doc.id === 'doc_a').content, 'CURRENT_DOCUMENT');
                        assert.equal(data.backup.learningItems.some(item => item.id === 'PRIVATE_DELETED_ITEM'), true);
                        assert.equal(data.persisted.marked, true);
                        assert.equal(data.outbox.entityId, 'item_legacy');
                        assert.equal(data.bucket, null);
                    });
                }

                await run('snapshot uses persisted content after article memory is changed', async () => {
                    const data = await page.evaluate(async () => {
                        const { a, r } = window.readingExportTest;
                        const loaded = await a.ensureArticleLoadedDetailed('article_a');
                        if (!loaded.ok) return loaded;
                        a.getRecord('article_a').article = 'PRIVATE_MUTABLE_MEMORY';
                        a.getRecord('article_a').lastOpenedAt = 'PRIVATE_MUTABLE_TIME';
                        const snapshot = await r.exportArticleReading('article_a');
                        return { ok: snapshot.ok, error: snapshot.error, body: snapshot.articleDoc?.body, opened: snapshot.articleDoc?.lastOpenedAt };
                    });
                    assert.equal(data.ok, true, JSON.stringify(data));
                    assert.equal(data.body, 'CURRENT_FULL_BODY');
                    assert.equal(data.opened, '2026-10-27T12:34:56.789Z');
                });

                await run('cached preflight still rejects an account switch during export', async () => {
                    const data = await page.evaluate(async () => {
                        const { a, r, scopeB } = window.readingExportTest;
                        const exporting = r.exportArticleReading('article_a');
                        // export 的第一個 await 已排入 microtask，reloadScope 同步提高文章世代。
                        const switched = a.reloadScope(scopeB);
                        const readingSwitched = r.reloadReadingScope(scopeB);
                        await Promise.all([switched, readingSwitched]);
                        return exporting;
                    });
                    assert.deepEqual(data, { ok: false, error: 'stale_scope' });
                });

                await run('overlapping IDs use the new account and reject stale A-to-B-to-A contexts', async () => {
                    const data = await page.evaluate(async () => {
                        const { a, r, scopeA, scopeB } = window.readingExportTest;
                        await a.reloadScope(scopeA);
                        await r.reloadReadingScope(scopeA);
                        const stale = r.captureReadingContext();
                        await a.reloadScope(scopeB);
                        await r.reloadReadingScope(scopeB);
                        const snapshot = await r.exportArticleReading('article_a');
                        await a.reloadScope(scopeA);
                        await r.reloadReadingScope(scopeA);
                        const rejected = await r.exportArticleReading('article_a', stale);
                        return {
                            ok: snapshot.ok, error: snapshot.error, scope: snapshot.scope,
                            body: snapshot.articleDoc?.body, note: snapshot.learningItems?.find(item => item.id === 'item_a')?.note,
                            messages: snapshot.messages?.map(message => message.content), rejected
                        };
                    });
                    assert.equal(data.ok, true, JSON.stringify(data));
                    assert.equal(data.scope, 'reading-export-regression::B');
                    assert.equal(data.body, 'PRIVATE_ACCOUNT_B_FULL_BODY');
                    assert.equal(data.note, 'PRIVATE_ACCOUNT_B_NOTE_item_a');
                    assert.deepEqual(data.messages, ['PRIVATE_ACCOUNT_B_CHAT_message_a']);
                    assert.deepEqual(data.rejected, { ok: false, error: 'stale_scope' });
                });

                await run('vocabulary context follows item order and retained source precedence', async () => {
                    const data = await page.evaluate(async () => {
                        const { r, db, scopeA, readingKey, articleKey, fallback, record } = window.readingExportTest;
                        const articleId = 'projection_article';
                        const items = [
                            record(scopeA, 'projection_item_a', { articleId, marked: false, sentence: 'FIRST_ITEM_SENTENCE' }),
                            record(scopeA, 'projection_item_b', { articleId, marked: false, sentence: '' }),
                            record(scopeA, 'projection_item_z', { articleId, marked: false, sentence: 'LATER_ITEM_SENTENCE' })
                        ];
                        const entries = [
                            ['item', [], 'PRIVATE_CONTEXT'],
                            ['sentence', [{ articleId, sentence: 'RETAINED_SENTENCE', context: 'RETAINED_CONTEXT' }], 'PRIVATE_CONTEXT'],
                            ['context', [{ articleId, sentence: '', context: 'RETAINED_CONTEXT' }], 'PRIVATE_CONTEXT'],
                            ['blank_first', [], 'PRIVATE_CONTEXT'],
                            ['local', [{ articleId, sentence: 'LOCAL_SOURCE' }], 'ORIGINAL_LOCAL_CONTEXT']
                        ].map(([id, sources, context]) => record(scopeA, `projection_entry_${id}`, {
                            bookId: 'projection_book', word: id, context,
                            sourceArticleId: id === 'local' ? articleId : 'article_b',
                            sources: id === 'local' ? sources : [{ articleId: 'article_b', sentence: 'PRIVATE_SOURCE' }, ...sources]
                        }));
                        // link 的主鍵與陣列次序都先指向較後的 item；不能採第一個 link。
                        const links = entries.flatMap(entry => [
                            record(scopeA, `${entry.id}_link_a`, { itemId: 'projection_item_z', bookId: 'projection_book', entryId: entry.id }),
                            record(scopeA, `${entry.id}_link_z`, { itemId: entry.word === 'blank_first' ? 'projection_item_b' : 'projection_item_a', bookId: 'projection_book', entryId: entry.id })
                        ]);
                        const book = record(scopeA, 'projection_book', { name: 'Projection', articleId });
                        const article = record(scopeA, articleId, { title: 'Projection', body: 'Projection body.' });
                        if (fallback) {
                            const bucket = JSON.parse(localStorage.getItem(readingKey(scopeA)));
                            bucket.items.push(...items);
                            bucket.entries.push(...entries);
                            bucket.links.push(...links);
                            bucket.books.push(book);
                            localStorage.setItem(readingKey(scopeA), JSON.stringify(bucket));
                            const articles = JSON.parse(localStorage.getItem(articleKey(scopeA)));
                            articles.docs.push(article);
                            localStorage.setItem(articleKey(scopeA), JSON.stringify(articles));
                        } else {
                            const seeded = await db.applyPermanentOperations([
                                ...items.map(value => ({ store: db.STORE.READING_ITEMS, type: 'put', value })),
                                ...entries.map(value => ({ store: db.STORE.VOCAB_ENTRIES, type: 'put', value })),
                                ...links.map(value => ({ store: db.STORE.VOCAB_LINKS, type: 'put', value })),
                                { store: db.STORE.VOCAB_BOOKS, type: 'put', value: book },
                                { store: db.STORE.DOCS, type: 'put', value: article }
                            ]);
                            if (!seeded.ok) throw new Error(JSON.stringify(seeded));
                        }
                        return r.exportArticleReading(articleId);
                    });
                    assert.equal(data.ok, true, JSON.stringify(data));
                    const entries = Object.fromEntries(data.vocabularyEntries.map(entry => [entry.word, entry]));
                    assert.equal(entries.item.context, 'FIRST_ITEM_SENTENCE');
                    assert.equal(entries.item.sourceArticleId, '');
                    assert.deepEqual(entries.item.sources, []);
                    assert.equal(entries.sentence.context, 'RETAINED_SENTENCE');
                    assert.equal(entries.sentence.sourceArticleId, 'projection_article');
                    assert.equal(entries.context.context, 'RETAINED_CONTEXT');
                    assert.equal(entries.context.sourceArticleId, 'projection_article');
                    assert.equal(entries.blank_first.context, '');
                    assert.equal(entries.local.context, 'ORIGINAL_LOCAL_CONTEXT');
                    assert.equal(JSON.stringify(data).includes('PRIVATE_'), false);
                });

                if (!fallback) {
                    await run('IDB loader, marked migration and snapshot errors stay explicit and retryable', async () => {
                        const cases = await page.evaluate(async () => {
                            const { r, db, scopeA, readingKey } = window.readingExportTest;
                            const output = [];
                            for (const stage of ['load', 'migration', 'articleExport', 'fullExport']) {
                                const itemKey = `${scopeA}\u0000item_legacy`;
                                const outboxKey = `${scopeA}\u0000learningItem\u0000item_legacy`;
                                if (stage === 'migration') {
                                    const current = await db.readStoreOne(db.STORE.READING_ITEMS, itemKey);
                                    delete current.value.marked;
                                    current.value.revision = 7;
                                    const seeded = await db.applyPermanentOperations([
                                        { store: db.STORE.READING_ITEMS, type: 'put', value: current.value },
                                        { store: db.STORE.READING_OUTBOX, type: 'delete', key: outboxKey }
                                    ]);
                                    if (!seeded.ok) throw new Error(JSON.stringify(seeded));
                                }
                                await r.reloadReadingScope(scopeA);
                                if (stage === 'articleExport') {
                                    const loaded = await r.ensureArticleReadingLoaded('article_a');
                                    if (!loaded.ok) throw new Error(JSON.stringify(loaded));
                                }
                                const beforeItem = await db.readStoreOne(db.STORE.READING_ITEMS, itemKey);
                                const beforeOutbox = await db.readStoreOne(db.STORE.READING_OUTBOX, outboxKey);
                                const originalTransaction = IDBDatabase.prototype.transaction;
                                let failures = 0;
                                IDBDatabase.prototype.transaction = function transaction(names, mode, ...rest) {
                                    const stores = typeof names === 'string' ? [names] : Array.from(names);
                                    const target = stage === 'load'
                                        ? mode === 'readonly' && stores.length === 1 && stores[0] === db.STORE.READING_ITEMS
                                        : stage === 'migration'
                                            ? mode === 'readwrite' && stores.includes(db.STORE.READING_ITEMS) && stores.includes(db.STORE.READING_OUTBOX)
                                            : stage === 'articleExport'
                                                ? mode === 'readonly' && stores.includes(db.STORE.DOCS)
                                                : mode === 'readonly' && stores.includes(db.STORE.ARTICLE_VERSIONS);
                                    if (target && failures === 0) {
                                        failures += 1;
                                        throw new DOMException(`test one-off ${stage} failure`, 'UnknownError');
                                    }
                                    return originalTransaction.call(this, names, mode, ...rest);
                                };
                                let failed;
                                try {
                                    failed = stage === 'fullExport'
                                        ? await r.exportAll(r.captureReadingContext(), { hydrate: false })
                                        : await r.exportArticleReading('article_a');
                                } finally {
                                    IDBDatabase.prototype.transaction = originalTransaction;
                                }
                                const afterItem = await db.readStoreOne(db.STORE.READING_ITEMS, itemKey);
                                const afterOutbox = await db.readStoreOne(db.STORE.READING_OUTBOX, outboxKey);
                                const retriedLoad = await r.ensureArticleReadingLoaded('article_a');
                                const retried = await r.exportArticleReading('article_a');
                                const backup = await r.exportAll(r.captureReadingContext(), { hydrate: false });
                                const persisted = await db.readStoreOne(db.STORE.READING_ITEMS, itemKey);
                                const outbox = await db.readStoreOne(db.STORE.READING_OUTBOX, outboxKey);
                                output.push({
                                    stage, failures, failed, retriedLoad, retried, backup,
                                    unchanged: JSON.stringify([beforeItem.value, beforeOutbox.value]) === JSON.stringify([afterItem.value, afterOutbox.value]),
                                    persisted: persisted.value, outbox: outbox.value, bucket: localStorage.getItem(readingKey(scopeA))
                                });
                            }
                            return output;
                        });
                        assert.equal(cases.length, 4);
                        for (const data of cases) {
                            assert.equal(data.failures, 1, data.stage);
                            assert.equal(data.failed.ok, false, JSON.stringify(data.failed));
                            assert.equal(data.failed.error, 'idb_transaction_failed', data.stage);
                            assert.equal(data.unchanged, true, data.stage);
                            assert.equal(data.retriedLoad.ok, true, JSON.stringify(data.retriedLoad));
                            assert.equal(data.retried.ok, true, JSON.stringify(data.retried));
                            assert.equal(data.retried.learningItems.find(item => item.id === 'item_legacy').note, 'CURRENT_NOTE_item_legacy');
                            assert.equal(data.retried.articleDocuments.find(doc => doc.id === 'doc_a').content, 'CURRENT_DOCUMENT');
                            assert.equal(data.backup.ok, true, JSON.stringify(data.backup));
                            assert.equal(data.backup.learningItems.find(item => item.id === 'item_legacy').note, 'CURRENT_NOTE_item_legacy');
                            assert.equal(data.bucket, null);
                            if (data.stage === 'migration') {
                                assert.equal(data.persisted.marked, true);
                                assert.equal(data.persisted.revision, 7);
                                assert.equal(data.outbox.expectedRevision, 7);
                                assert.equal(data.outbox.patch.note, 'CURRENT_NOTE_item_legacy');
                            }
                        }
                    });
                }

                if (fallback) {
                    await run('reading and article storage failures never become successful empty exports', async () => {
                        const cases = await page.evaluate(async () => {
                            const { r, scopeA, readingKey, articleKey } = window.readingExportTest;
                            const output = [];
                            for (const key of [readingKey(scopeA), articleKey(scopeA)]) {
                                for (const cold of [true, false]) {
                                    await r.reloadReadingScope(scopeA);
                                    if (!cold) await r.exportArticleReading('article_a');
                                    const originalGet = Storage.prototype.getItem;
                                    Storage.prototype.getItem = function getItem(target) {
                                        if (target === key) throw new DOMException('test blocked read', 'SecurityError');
                                        return originalGet.call(this, target);
                                    };
                                    try {
                                        output.push({ key, cold, result: await r.exportArticleReading('article_a') });
                                    } finally {
                                        Storage.prototype.getItem = originalGet;
                                    }
                                }
                            }
                            return output;
                        });
                        assert.equal(cases.length, 4);
                        for (const item of cases) assert.deepEqual(item.result, { ok: false, error: 'storage_read_failed' }, JSON.stringify(item));
                    });

                    await run('corrupt bucket syntax and shapes fail explicitly and remain intact', async () => {
                        const cases = await page.evaluate(async () => {
                            const { r, scopeA, readingKey, articleKey } = window.readingExportTest;
                            const output = [];
                            for (const [key, values] of [
                                [readingKey(scopeA), ['{"items":[', '{"items":{}}', '[]', '{"state":[]}']],
                                [articleKey(scopeA), ['{"docs":[', '{"docs":{}}', '[]', '{"docs":[],"outbox":{}}', '{"docs":[],"state":[]}']]
                            ]) {
                                const saved = localStorage.getItem(key);
                                try {
                                    for (const value of values) {
                                        await r.reloadReadingScope(scopeA);
                                        localStorage.setItem(key, value);
                                        const result = await r.exportArticleReading('article_a');
                                        output.push({ result, unchanged: localStorage.getItem(key) === value });
                                        localStorage.setItem(key, saved);
                                    }
                                } finally {
                                    localStorage.setItem(key, saved);
                                }
                            }
                            return output;
                        });
                        assert.equal(cases.length, 9);
                        for (const item of cases) {
                            assert.deepEqual(item.result, { ok: false, error: 'storage_corrupt' }, JSON.stringify(item));
                            assert.equal(item.unchanged, true);
                        }
                    });

                    await run('failed marked migration preserves the bucket and can be retried', async () => {
                        const data = await page.evaluate(async () => {
                            const { r, scopeA, readingKey } = window.readingExportTest;
                            const key = readingKey(scopeA);
                            const bucket = JSON.parse(localStorage.getItem(key));
                            delete bucket.items.find(item => item.id === 'item_legacy').marked;
                            localStorage.setItem(key, JSON.stringify(bucket));
                            await r.reloadReadingScope(scopeA);
                            const before = localStorage.getItem(key);
                            const originalSet = Storage.prototype.setItem;
                            Storage.prototype.setItem = function setItem(target, value) {
                                if (target === key) throw new DOMException('test full', 'QuotaExceededError');
                                return originalSet.call(this, target, value);
                            };
                            let failed;
                            try {
                                failed = await r.exportArticleReading('article_a');
                            } finally {
                                Storage.prototype.setItem = originalSet;
                            }
                            const unchanged = before === localStorage.getItem(key);
                            const retried = await r.exportArticleReading('article_a');
                            return { failed, unchanged, ok: retried.ok, marked: retried.learningItems?.find(item => item.id === 'item_legacy')?.marked };
                        });
                        assert.equal(data.failed.ok, false, JSON.stringify(data));
                        assert.equal(data.failed.error, 'storage_full');
                        assert.equal(data.unchanged, true);
                        assert.equal(data.ok, true);
                        assert.equal(data.marked, true);
                    });

                    await run('a read failure during marked migration cannot overwrite existing content', async () => {
                        const data = await page.evaluate(async () => {
                            const { r, scopeA, readingKey } = window.readingExportTest;
                            const key = readingKey(scopeA);
                            const bucket = JSON.parse(localStorage.getItem(key));
                            delete bucket.items.find(item => item.id === 'item_legacy').marked;
                            localStorage.setItem(key, JSON.stringify(bucket));
                            await r.reloadReadingScope(scopeA);
                            const before = localStorage.getItem(key);
                            const originalGet = Storage.prototype.getItem;
                            let reads = 0;
                            Storage.prototype.getItem = function getItem(target) {
                                if (target === key && ++reads >= 2) throw new DOMException('test interrupted read', 'SecurityError');
                                return originalGet.call(this, target);
                            };
                            let failed;
                            try {
                                failed = await r.exportArticleReading('article_a');
                            } finally {
                                Storage.prototype.getItem = originalGet;
                            }
                            const unchanged = before === localStorage.getItem(key);
                            const retried = await r.exportArticleReading('article_a');
                            return { failed, unchanged, reads, ok: retried.ok };
                        });
                        assert.equal(data.reads, 2);
                        assert.equal(data.failed.error, 'storage_read_failed');
                        assert.equal(data.unchanged, true);
                        assert.equal(data.ok, true);
                    });

                    await run('an established fallback backend keeps its records when IDB becomes available', async () => {
                        const data = await page.evaluate(async () => {
                            const { r, db, scopeA, readingKey, fixtures } = window.readingExportTest;
                            const before = localStorage.getItem(readingKey(scopeA));
                            Object.defineProperty(window, 'indexedDB', { configurable: true, value: window.readingExportNativeIndexedDb });
                            try {
                                const { bucket } = fixtures(scopeA);
                                const idbItem = { ...bucket.items[0], note: 'IDB_ALTERNATIVE_NOTE' };
                                const seeded = await db.applyPermanentOperations([
                                    { store: db.STORE.READING_ITEMS, type: 'put', value: idbItem },
                                    { store: db.STORE.ARTICLE_DOCUMENTS, type: 'put', value: { ...bucket.documents[0], content: 'IDB_ALTERNATIVE_DOCUMENT' } },
                                    { store: db.STORE.VOCAB_BOOKS, type: 'put', value: { ...bucket.books[0], name: 'IDB_ALTERNATIVE_BOOK' } },
                                    { store: db.STORE.VOCAB_ENTRIES, type: 'put', value: { ...bucket.entries[0], meaning: 'IDB_ALTERNATIVE_MEANING' } },
                                    { store: db.STORE.VOCAB_LINKS, type: 'put', value: bucket.links[0] }
                                ]);
                                if (!seeded.ok) throw new Error(JSON.stringify(seeded));
                                const initialized = await r.initReadingStore(scopeA);
                                const loaded = await r.ensureArticleReadingLoaded('article_a');
                                const snapshot = await r.exportArticleReading('article_a');
                                const backup = await r.exportAll(r.captureReadingContext(), { hydrate: false });
                                const persisted = await db.readStoreOne(db.STORE.READING_ITEMS, idbItem.key);
                                return {
                                    initialized, loaded, snapshot, backup,
                                    books: r.listVocabularyBooks(), entries: r.listVocabularyEntries('book_a'),
                                    note: r.getLearningItem('item_a')?.note, document: r.getArticleDocument('doc_a')?.content,
                                    unchanged: before === localStorage.getItem(readingKey(scopeA)), idbNote: persisted.value?.note
                                };
                            } finally {
                                Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
                            }
                        });
                        assert.equal(data.initialized.fallbackMode, true);
                        assert.equal(data.loaded.ok, true, JSON.stringify(data.loaded));
                        assert.equal(data.note, 'CURRENT_NOTE_item_a');
                        assert.equal(data.document, 'CURRENT_DOCUMENT');
                        assert.equal(data.books.find(book => book.id === 'book_a').name, 'CURRENT_BOOK');
                        assert.equal(data.entries.find(entry => entry.id === 'entry_a').meaning, 'shared definition');
                        assert.equal(data.snapshot.ok, true, JSON.stringify(data.snapshot));
                        assert.equal(data.snapshot.learningItems.find(item => item.id === 'item_a').note, 'CURRENT_NOTE_item_a');
                        assert.equal(data.snapshot.articleDocuments[0].content, 'CURRENT_DOCUMENT');
                        assert.equal(data.backup.ok, true, JSON.stringify(data.backup));
                        assert.equal(data.backup.learningItems.find(item => item.id === 'item_a').note, 'CURRENT_NOTE_item_a');
                        assert.equal(data.unchanged, true);
                        assert.equal(data.idbNote, 'IDB_ALTERNATIVE_NOTE');
                    });
                }
            } finally {
                await context.close();
            }
        }
    } finally {
        await browser.close();
    }
    console.log(JSON.stringify(results, null, 2));
    process.exitCode = results.every(result => result.ok) ? 0 : 1;
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
