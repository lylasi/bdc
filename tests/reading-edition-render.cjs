/**
 * 固定快照、原文定位及獨立離線 HTML 的瀏覽器回歸。
 * PORT=8327 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/reading-edition-render.cjs
 * 使用已啟動的靜態伺服器；不改動真實帳戶資料。
 */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const PORT = Number(process.env.PORT || 8327);
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function smallWave() {
    const bytes = Buffer.alloc(844, 128);
    bytes.write('RIFF', 0);
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.write('WAVEfmt ', 8);
    bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20);
    bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(8000, 24);
    bytes.writeUInt32LE(8000, 28);
    bytes.writeUInt16LE(1, 32);
    bytes.writeUInt16LE(8, 34);
    bytes.write('data', 36);
    bytes.writeUInt32LE(800, 40);
    return { name: 'Local audio <"&\'>.wav', type: 'audio/wav', size: bytes.length, dataUrl: `data:audio/wav;base64,${bytes.toString('base64')}` };
}

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: CHROME });
    const results = [];
    const check = async (name, action) => {
        await action();
        results.push(name);
        console.log(`PASS ${name}`);
    };
    try {
        const context = await browser.newContext();
        await context.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (url.origin !== BASE) return route.abort();
            if (url.pathname === '/__reading-edition-test__.html') {
                return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>' });
            }
            if (url.pathname.endsWith('/ai-config.js')) {
                return route.fulfill({ contentType: 'application/javascript', body: 'export const SYNC={endpoint:""}; export const TTS_CONFIG={}, AI_LIMITS={}, OCR_CONFIG={}, ARTICLE_IMPORT={}, SUPABASE={};' });
            }
            return route.continue();
        });
        const source = await context.newPage();
        const sourceErrors = [];
        source.on('pageerror', (error) => sourceErrors.push(String(error)));
        await source.goto(`${BASE}/__reading-edition-test__.html`);
        const fixture = await source.evaluate(async (audio) => {
            const edition = await import('/modules/reading-edition.js');
            const i18n = await import('/modules/i18n.js');
            const { contentVersionOf } = await import('/shared/reading-protocol.mjs');
            const articleId = 'article-A-private-id';
            const body = '\r\n  alpha beta alpha.\r\nA second line: <>&"\' 😀\tEND\n\n' + 'unbroken_'.repeat(70);
            const contentVersion = contentVersionOf(body);
            const first = body.indexOf('alpha');
            const second = body.indexOf('alpha', first + 1);
            const anchor = (start, end) => ({ start, end, quote: body.slice(start, end) });
            const item = (id, input = {}) => ({
                id,
                articleId,
                kind: 'word',
                anchor: anchor(first, first + 5),
                contentVersion,
                positionUncertain: false,
                marked: false,
                understanding: 'unmarked',
                createdAt: '2026-10-28T06:00:00.000Z',
                firstViewedAt: '2026-10-28T06:01:00.000Z',
                lastViewedAt: '2026-10-28T07:01:00.000Z',
                explanation: { result: 'SAVED_EXPLANATION', provenance: { secret: 'PROVENANCE_CREDENTIAL_PRIVATE' } },
                ...input
            });
            const valid = [
                item('item-one-private-id', {
                    marked: true,
                    understanding: 'needs_review',
                    sentence: 'SAVED_WORD_CONTEXT',
                    note: '**PERSONAL_NOTE**\n\n[Safe link](https://example.invalid/reading?q=1&lang=en)\n\n![note image](https://image.invalid/pixel?token=IMAGE_CREDENTIAL) AFTER_IMAGE_LINE\n\nInline ![inline image](/pixel.png) AFTER_INLINE_IMAGE\n\n<script>window.EDITION_ATTACK=1</script>',
                    explanation: {
                        provenance: { secret: 'PROVENANCE_CREDENTIAL_PRIVATE' },
                        result: {
                            word: 'alpha',
                            sentence: 'SAVED_WORD_CONTEXT',
                            analysis: {
                                phonetic: '/æl.fə/',
                                pos: 'SAVED_PART_OF_SPEECH',
                                meaning: 'SAVED_WORD_MEANING',
                                role: 'SAVED_GRAMMAR_ROLE',
                                usage: 'SAVED_WORD_USAGE',
                                examples: [
                                    { en: 'EXAMPLE_ONE', zh: 'EXAMPLE_ONE_TRANSLATION' },
                                    { en: 'EXAMPLE_TWO', zh: 'EXAMPLE_TWO_TRANSLATION' },
                                    { en: 'EXAMPLE_THREE', zh: 'EXAMPLE_THREE_TRANSLATION', note: 'EXAMPLE_THREE_NOTE' }
                                ]
                            }
                        }
                    }
                }),
                item('item-two-private-id', { anchor: anchor(second, second + 5), understanding: 'understood' }),
                item('item-phrase-private-id', {
                    kind: 'phrase', anchor: anchor(first, first + 10),
                    explanation: { result: { selection: 'alpha beta', analysis: { phonetic: 'PHRASE_IPA', meaning: 'SAVED_PHRASE_MEANING', usage: 'SAVED_PHRASE_USAGE', examples: [{ en: 'PHRASE_EXAMPLE', zh: 'PHRASE_TRANSLATION' }] } } }
                }),
                item('item-crossing-private-id', { kind: 'phrase', anchor: anchor(first + 6, second + 5) }),
                item('item-duplicate-private-id', { note: 'DUPLICATE_OCCURRENCE_NOTE', explanation: { result: 'PLAIN_STRING_EXPLANATION' } }),
                item('item-sentence-private-id', {
                    kind: 'sentence', anchor: anchor(first, second + 6),
                    explanation: {
                        result: {
                            sentence: 'SAVED_SENTENCE_CONTEXT',
                            translation: 'FULL_SENTENCE_TRANSLATION',
                            phrase_alignment: [{ en: 'ALIGNMENT_ORIGINAL', zh: 'ALIGNMENT_TRANSLATION' }],
                            chunks: [{ text: 'CHUNK_TEXT', role: 'CHUNK_ROLE', note: 'CHUNK_NOTE' }],
                            key_points: ['KEY_POINT_ONE', 'KEY_POINT_TWO']
                        }
                    }
                })
            ];
            const invalid = [
                item('stale-private-id', { contentVersion: 'old_version', note: 'DETACHED_STALE' }),
                item('uncertain-private-id', { positionUncertain: true, note: 'DETACHED_UNCERTAIN' }),
                item('missing-certainty-private-id', { positionUncertain: undefined, note: 'DETACHED_MISSING_CERTAINTY' }),
                item('null-certainty-private-id', { positionUncertain: null, note: 'DETACHED_NULL_CERTAINTY' }),
                item('number-certainty-private-id', { positionUncertain: 0, note: 'DETACHED_NUMBER_CERTAINTY' }),
                item('string-start-private-id', { anchor: { ...anchor(first, first + 5), start: String(first) }, note: 'DETACHED_STRING_START' }),
                item('fractional-end-private-id', { anchor: { ...anchor(first, first + 5), end: first + 5.5 }, note: 'DETACHED_FRACTIONAL' }),
                item('negative-private-id', { anchor: { start: -1, end: 4, quote: 'alpha' }, note: 'DETACHED_NEGATIVE' }),
                item('bounds-private-id', { anchor: { start: body.length - 2, end: body.length + 3, quote: 'alpha' }, note: 'DETACHED_BOUNDS' }),
                item('length-private-id', { anchor: { ...anchor(first, first + 5), end: first + 6 }, note: 'DETACHED_LENGTH' }),
                item('quote-private-id', { anchor: { ...anchor(first, first + 5), quote: 'ALPHA' }, note: 'DETACHED_QUOTE' }),
                item('zero-private-id', { anchor: { start: first, end: first, quote: '' }, note: 'DETACHED_EMPTY' }),
                item('no-anchor-private-id', { anchor: null, firstViewedAt: null, lastViewedAt: 'bad-date', note: 'DETACHED_NO_ANCHOR' })
            ];
            const conversation = { id: 'conversation-private-id', articleId, title: 'SAVED_CONVERSATION', createdAt: '2026-10-28T06:00:00.000Z' };
            const message = (id, input = {}) => ({ id, conversationId: conversation.id, role: 'assistant', status: 'complete', content: `SAVED_${id}`, createdAt: '2026-10-28T08:00:00.000Z', ...input });
            const snapshot = {
                ok: true,
                scope: 'account-private-scope',
                untouched: { retained: true },
                credentials: { key: 'EXCLUDED_ACCOUNT_SECRET' },
                articleId,
                articleDoc: {
                    id: articleId,
                    title: 'Title <"&\'> 完整原文',
                    body,
                    sourceType: 'url',
                    sourceUrl: 'https://example.invalid/article?section=2',
                    lastOpenedAt: '2026-10-28T07:07:00.000Z'
                },
                learningItems: [
                    ...valid, ...invalid,
                    item('deleted-private-id', { deletedAt: '2026-10-28T08:00:00Z', note: 'EXCLUDED_DELETED_ITEM' }),
                    item('foreign-private-id', { articleId: 'article-B', note: 'EXCLUDED_FOREIGN_ITEM' }),
                    item('wrong-scope-private-id', { scope: 'other-account', note: 'EXCLUDED_OTHER_SCOPE' })
                ],
                articleDocuments: [
                    { id: 'note-private-id', articleId, kind: 'note', title: 'SAVED_ARTICLE_NOTE', content: 'ARTICLE_NOTE_BODY\n\n| Field | Value |\n| --- | --- |\n| Saved | Complete |', createdAt: '2026-10-28T06:00:00.000Z' },
                    {
                        id: 'ai-doc-private-id', articleId, kind: 'ai', title: 'SAVED_AI_DOCUMENT',
                        content: 'AI_DOCUMENT_BODY\n\n[Relative](/should-never-open)\n[Protocol relative](//resource.invalid/no)\n[Unsafe](javascript:alert(1))\n[Credential](https://example.invalid/?api_key=CREDENTIAL_IN_URL)\n[Encoded credential](https://example.invalid/?access%5Ftoken=ENCODED_CREDENTIAL_IN_URL)\n[Userinfo](https://someone:PASSWORD_PRIVATE@example.invalid/)\n[Mail](mailto:reader@example.invalid)\n[Telephone](tel:+85212345678)\n[Quote](https://example.invalid/%22onclick=%22inert)\n\n![Remote image](https://resource.invalid/pixel) TRAILING_IMAGE_TEXT\n\n<img src="https://resource.invalid/raw" onerror="alert(1)"><iframe src="https://resource.invalid/frame"></iframe>\n\n```html\n<script>literal saved example</script>\n```',
                        sourceItemIds: ['item-one-private-id', 'foreign-private-id', 'missing-private-id'],
                        sourceMessageIds: ['m04', 'missing-message-private-id'],
                        updatedAt: '2026-10-28T08:00:00.000Z'
                    },
                    { id: 'foreign-doc-private-id', articleId: 'article-B', kind: 'note', content: 'EXCLUDED_FOREIGN_DOCUMENT' },
                    { id: 'deleted-doc-private-id', articleId, deletedAt: '2026-10-28T08:00:00Z', content: 'EXCLUDED_DELETED_DOCUMENT' }
                ],
                conversations: [conversation, { id: 'empty-conversation-private-id', articleId, title: 'SAVED_EMPTY_CONVERSATION' }, { id: 'foreign-conversation-private-id', articleId: 'article-B', title: 'EXCLUDED_FOREIGN_CONVERSATION' }, { id: 'deleted-conversation-private-id', articleId, deletedAt: '2026-10-28T08:00:00Z', title: 'EXCLUDED_DELETED_CONVERSATION' }],
                messages: [
                    message('m05', { status: 'partial', content: 'SAVED_PARTIAL_REPLY', createdAt: '2026-10-28T10:00:00.000Z' }),
                    message('m03', { createdAt: '2026-10-28T09:00:00+01:00' }),
                    message('m04', { status: 'cancelled', content: 'SAVED_CANCELLED_REPLY', createdAt: '2026-10-28T09:00:00.000Z', learningItemId: 'item-one-private-id' }),
                    message('m02'),
                    message('m01', { role: 'user', content: 'HISTORICAL_USER_CONTENT 原文不轉換', createdAt: '2026-10-28T07:00:00.000Z' }),
                    message('m06', { role: 'system', status: 'queued', content: 'SAVED_QUEUED_REPLY', createdAt: '2026-10-28T11:00:00.000Z' }),
                    message('deleted-message-private-id', { deletedAt: '2026-10-28T08:00:00Z', content: 'EXCLUDED_DELETED_MESSAGE' }),
                    message('foreign-message-private-id', { conversationId: 'foreign-conversation-private-id', content: 'EXCLUDED_FOREIGN_MESSAGE' }),
                    message('dead-conversation-message-private-id', { conversationId: 'deleted-conversation-private-id', content: 'EXCLUDED_DELETED_CONVERSATION_MESSAGE' }),
                    message('orphan-message-private-id', { conversationId: 'missing-conversation-private-id', content: 'EXCLUDED_ORPHAN_MESSAGE' }),
                    message('wrong-scope-message-private-id', { scope: 'other-account', content: 'EXCLUDED_SCOPE_MESSAGE' })
                ],
                messagesByConversation: new Map([['bogus', [{ id: 'map-only-private-id', content: 'EXCLUDED_STALE_MESSAGE_MAP' }]]]),
                vocabularyBooks: [
                    { id: 'book-private-id', name: 'RELEVANT_BOOK <&>' },
                    { id: 'unused-book-private-id', name: 'EXCLUDED_UNRELATED_BOOK' },
                    { id: 'deleted-book-private-id', name: 'EXCLUDED_DELETED_BOOK', deletedAt: '2026-10-28T08:00:00Z' }
                ],
                vocabularyEntries: [
                    { id: 'entry-private-id', bookId: 'book-private-id', word: 'SAVED_VOCABULARY_WORD' },
                    { id: 'unused-entry-private-id', bookId: 'unused-book-private-id', word: 'EXCLUDED_UNRELATED_ENTRY' },
                    { id: 'deleted-entry-private-id', bookId: 'book-private-id', word: 'EXCLUDED_DELETED_ENTRY', deletedAt: '2026-10-28T08:00:00Z' }
                ],
                vocabularyLinks: [
                    { id: 'link-private-id', itemId: 'item-one-private-id', bookId: 'book-private-id', entryId: 'entry-private-id' },
                    { id: 'repeat-link-private-id', itemId: 'item-two-private-id', bookId: 'book-private-id', entryId: 'entry-private-id' },
                    { id: 'foreign-link-private-id', itemId: 'foreign-private-id', bookId: 'unused-book-private-id', entryId: 'unused-entry-private-id' },
                    { id: 'removed-link-private-id', itemId: 'item-one-private-id', bookId: 'unused-book-private-id', entryId: 'unused-entry-private-id', removedAt: '2026-10-28T08:00:00Z' },
                    { id: 'deleted-link-private-id', itemId: 'item-one-private-id', bookId: 'unused-book-private-id', entryId: 'unused-entry-private-id', deletedAt: '2026-10-28T08:00:00Z' },
                    { id: 'dead-entry-link-private-id', itemId: 'item-one-private-id', bookId: 'book-private-id', entryId: 'deleted-entry-private-id' },
                    { id: 'dead-book-link-private-id', itemId: 'item-one-private-id', bookId: 'deleted-book-private-id', entryId: 'entry-private-id' },
                    { id: 'mismatch-link-private-id', itemId: 'item-one-private-id', bookId: 'unused-book-private-id', entryId: 'entry-private-id' }
                ],
                articleOutboxCount: 1,
                readingOutboxCount: 2,
                readingState: { lastError: 'EXCLUDED_RAW_ERROR', conflicts: { 'learningItem:item-one-private-id': { local: { note: 'EXCLUDED_CONFLICT_PAYLOAD' }, remote: { apiKey: 'EXCLUDED_REMOTE_SECRET' } } } },
                articleState: { conflicts: { [articleId]: { local: { body: 'EXCLUDED_CONFLICT_ARTICLE' } } } }
            };
            window.editionTest = { edition, i18n, snapshot, articleId, body, valid, invalid, audio };
            return { body, title: snapshot.articleDoc.title, version: contentVersion, validCount: valid.length, detachedCount: invalid.length, itemCount: valid.length + invalid.length };
        }, smallWave());

        await check('selector isolates live article records, ordered conversation messages and vocabulary links without mutation', async () => {
            const actual = await source.evaluate(() => {
                const { edition, snapshot, articleId } = window.editionTest;
                const before = JSON.stringify(snapshot, (_key, value) => value instanceof Map ? [...value] : value);
                const selected = edition.selectArticleReading(snapshot, articleId);
                return {
                    unchanged: before === JSON.stringify(snapshot, (_key, value) => value instanceof Map ? [...value] : value),
                    retainsOther: selected.untouched === snapshot.untouched,
                    itemIds: selected.learningItems.map((item) => item.id),
                    documentIds: selected.articleDocuments.map((doc) => doc.id),
                    conversationIds: selected.conversations.map((conv) => conv.id),
                    messageIds: selected.messages.map((message) => message.id),
                    mapIds: selected.messagesByConversation.get('conversation-private-id').map((message) => message.id),
                    emptyMessages: selected.messagesByConversation.get('empty-conversation-private-id'),
                    links: selected.vocabularyLinks.map((link) => link.id),
                    books: selected.vocabularyBooks.map((book) => book.id),
                    entries: selected.vocabularyEntries.map((entry) => entry.id)
                };
            });
            assert.equal(actual.unchanged, true);
            assert.equal(actual.retainsOther, true);
            assert.equal(actual.itemIds.length, fixture.itemCount);
            assert.ok(!actual.itemIds.includes('foreign-private-id'));
            assert.ok(!actual.itemIds.includes('deleted-private-id'));
            assert.ok(!actual.itemIds.includes('wrong-scope-private-id'));
            assert.deepEqual(actual.documentIds, ['ai-doc-private-id', 'note-private-id']);
            assert.deepEqual(actual.conversationIds, ['empty-conversation-private-id', 'conversation-private-id']);
            assert.deepEqual(actual.messageIds, ['m01', 'm02', 'm03', 'm04', 'm05', 'm06']);
            assert.deepEqual(actual.mapIds, actual.messageIds);
            assert.deepEqual(actual.emptyMessages, []);
            assert.deepEqual(actual.links, ['link-private-id', 'repeat-link-private-id']);
            assert.deepEqual(actual.books, ['book-private-id']);
            assert.deepEqual(actual.entries, ['entry-private-id']);
        });

        await check('selector normalizes partial snapshots and supports retained legacy message maps', async () => {
            const actual = await source.evaluate(() => {
                const { edition, snapshot, articleId } = window.editionTest;
                const empty = edition.selectArticleReading(undefined, articleId);
                const legacy = { ...snapshot, messagesByConversation: new Map([['conversation-private-id', snapshot.messages]]) };
                delete legacy.messages;
                const mapSelected = edition.selectArticleReading(legacy, articleId);
                legacy.messagesByConversation = Object.fromEntries(legacy.messagesByConversation);
                const objectSelected = edition.selectArticleReading(legacy, articleId);
                const mismatched = edition.selectArticleReading(snapshot, 'different-article');
                const deleted = edition.selectArticleReading({ ...snapshot, articleDoc: { ...snapshot.articleDoc, deletedAt: 'now' } }, articleId);
                return {
                    keys: ['learningItems', 'articleDocuments', 'conversations', 'messages', 'vocabularyBooks', 'vocabularyEntries', 'vocabularyLinks'].map((key) => [key, Array.isArray(empty[key]) && empty[key].length === 0]),
                    emptyMap: empty.messagesByConversation instanceof Map,
                    mapMessages: mapSelected.messages.map((message) => message.id),
                    objectMessages: objectSelected.messages.map((message) => message.id),
                    mismatchEmpty: !mismatched.articleDoc && mismatched.learningItems.length === 0 && mismatched.messages.length === 0 && mismatched.vocabularyBooks.length === 0,
                    deletedEmpty: !deleted.articleDoc && deleted.articleDocuments.length === 0
                };
            });
            assert.ok(actual.keys.every(([_key, empty]) => empty));
            assert.equal(actual.emptyMap, true);
            assert.deepEqual(actual.mapMessages, ['m01', 'm02', 'm03', 'm04', 'm05', 'm06']);
            assert.deepEqual(actual.objectMessages, actual.mapMessages);
            assert.equal(actual.mismatchEmpty, true);
            assert.equal(actual.deletedEmpty, true);
        });

        await check('renderer rejects unavailable articles, failed snapshots and unsafe audio data', async () => {
            const actual = await source.evaluate(() => {
                const { edition, snapshot, articleId, audio } = window.editionTest;
                const errorOf = (options) => {
                    try { edition.renderReadingEdition(options); return ''; } catch (error) { return error.message; }
                };
                const base = { snapshot, articleId };
                const invalidAudio = [
                    null,
                    [{ ...audio, dataUrl: 'https://resource.invalid/audio.wav' }],
                    [{ ...audio, type: 'text/html', dataUrl: 'data:text/html;base64,PHNjcmlwdD4=' }],
                    [{ ...audio, type: 'audio/mpeg' }],
                    [{ ...audio, dataUrl: 'data:audio/wav;base64,broken!' }],
                    [{ ...audio, dataUrl: 'data:audio/wav;base64,' }],
                    [{ ...audio, dataUrl: `${audio.dataUrl}" onerror="alert(1)` }],
                    [{ ...audio, size: audio.size + 1 }],
                    Array.from({ length: 6 }, () => audio),
                    [{ name: 'oversized.wav', type: 'audio/wav', dataUrl: `data:audio/wav;base64,${'A'.repeat(4 * Math.ceil((25 * 1024 * 1024 + 1) / 3))}` }],
                    Array.from({ length: 2 }, () => ({ name: 'combined-too-large.wav', type: 'audio/wav', dataUrl: `data:audio/wav;base64,${'A'.repeat(4 * Math.ceil(13 * 1024 * 1024 / 3))}` }))
                ].map((audioTracks) => errorOf({ ...base, audioTracks }));
                const acceptedAudio = ['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/flac', 'audio/aac'].map((type) => {
                    const attachment = { ...audio, type, dataUrl: audio.dataUrl.replace('audio/wav', type) };
                    return edition.renderReadingEdition({ ...base, audioTracks: [attachment] }).meta.audioCount;
                });
                return {
                    missing: errorOf({ ...base, articleId: 'different' }),
                    deleted: errorOf({ ...base, snapshot: { ...snapshot, articleDoc: { ...snapshot.articleDoc, deletedAt: 'now' } } }),
                    failed: errorOf({ ...base, snapshot: { ...snapshot, ok: false } }),
                    invalidAudio,
                    acceptedAudio
                };
            });
            assert.equal(actual.missing, 'article_not_found');
            assert.equal(actual.deleted, 'article_not_found');
            assert.equal(actual.failed, 'snapshot_failed');
            assert.ok(actual.invalidAudio.every((error) => error === 'invalid_audio'));
            assert.ok(actual.acceptedAudio.every((count) => count === 1));
        });

        const outputs = {};
        for (const locale of ['zh-CN', 'zh-HK']) {
            outputs[locale] = await source.evaluate((locale) => {
                const { edition, i18n, snapshot, articleId, audio } = window.editionTest;
                i18n.setLocale(locale, { persist: false });
                const output = edition.renderReadingEdition({ snapshot, articleId, audioTracks: [audio], exportedAt: '2026-10-28T12:00:00.000Z' });
                return {
                    ...output,
                    labels: Object.fromEntries([
                        'article.editionTitle', 'article.editionDetached', 'article.editionFirstViewed', 'article.editionLastViewed',
                        'article.editionLastOpened', 'article.editionLocalSnapshot', 'article.editionIncomplete', 'article.editionSyncError',
                        'article.editionUnderstandingReview', 'article.editionUnderstandingUnderstood', 'article.editionNoAudio',
                        'assistant.streamCancelled', 'article.readingExportCaveatPending', 'article.readingChatNotLoaded'
                    ].map((key) => [key, i18n.t(key)]))
                };
            }, locale);
        }
        assert.equal(outputs['zh-CN'].meta.title, fixture.title);
        assert.equal(outputs['zh-CN'].meta.contentVersion, fixture.version);
        assert.equal(outputs['zh-CN'].meta.itemCount, fixture.itemCount);
        assert.equal(outputs['zh-CN'].meta.detachedCount, fixture.detachedCount);
        assert.equal(outputs['zh-CN'].meta.documentCount, 2);
        assert.equal(outputs['zh-CN'].meta.conversationCount, 2);
        assert.equal(outputs['zh-CN'].meta.messageCount, 6);
        assert.equal(outputs['zh-CN'].meta.audioCount, 1);
        assert.equal(outputs['zh-CN'].meta.conflictCount, 2);
        assert.equal(outputs['zh-CN'].meta.pending, true);
        assert.deepEqual(outputs['zh-CN'].meta, outputs['zh-HK'].meta);

        const offline = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1280, height: 900 } });
        const outboundRequests = [];
        offline.on('request', (request) => {
            if (!request.url().startsWith('data:')) outboundRequests.push(request.url());
        });
        await offline.route('**/*', (route) => route.abort());
        for (const locale of ['zh-CN', 'zh-HK']) {
            const { html, labels } = outputs[locale];
            const page = await offline.newPage();
            await page.setContent(html, { waitUntil: 'load' });
            await check(`${locale}: original characters, repeat/overlap records and detached records are preserved`, async () => {
                const actual = await page.evaluate(() => ({
                    lang: document.documentElement.lang,
                    title: document.querySelector('h1').textContent,
                    original: document.querySelector('#original-text').textContent,
                    cards: document.querySelectorAll('.learning-card').length,
                    detached: document.querySelectorAll('#detached .learning-card').length,
                    references: [...document.querySelectorAll('.text-reference')].map((link) => link.getAttribute('href')),
                    backs: [...document.querySelectorAll('.back-to-text')].map((link) => link.getAttribute('href')),
                    overlap: document.querySelectorAll('.overlap-mark').length,
                    text: document.body.textContent,
                    missingTargets: [...document.querySelectorAll('a[href^="#"]')].map((link) => link.getAttribute('href').slice(1)).filter((id) => !document.getElementById(id)),
                    ids: [...document.querySelectorAll('[id]')].map((node) => node.id)
                }));
                assert.equal(actual.lang, locale);
                assert.equal(actual.title, fixture.title);
                assert.equal(actual.original, fixture.body);
                assert.equal(actual.cards, fixture.itemCount);
                assert.equal(actual.detached, fixture.detachedCount);
                assert.equal(actual.references.length, fixture.validCount);
                assert.equal(new Set(actual.references).size, fixture.validCount);
                assert.equal(actual.backs.length, fixture.validCount);
                assert.equal(new Set(actual.backs).size, fixture.validCount);
                assert.ok(actual.overlap > 0);
                assert.deepEqual(actual.missingTargets, []);
                assert.equal(new Set(actual.ids).size, actual.ids.length);
                for (const token of ['DETACHED_STALE', 'DETACHED_UNCERTAIN', 'DETACHED_MISSING_CERTAINTY', 'DETACHED_NULL_CERTAINTY', 'DETACHED_NUMBER_CERTAINTY', 'DETACHED_STRING_START', 'DETACHED_FRACTIONAL', 'DETACHED_NEGATIVE', 'DETACHED_BOUNDS', 'DETACHED_LENGTH', 'DETACHED_QUOTE', 'DETACHED_EMPTY', 'DETACHED_NO_ANCHOR', 'DUPLICATE_OCCURRENCE_NOTE']) assert.ok(actual.text.includes(token), token);
            });

            await check(`${locale}: complete explanations, saved documents, sources and honest message/snapshot states`, async () => {
                const actual = await page.evaluate(() => ({
                    text: document.body.textContent,
                    docLinks: [...document.querySelectorAll('#ai-documents .source-link')].map((link) => link.getAttribute('href')),
                    unavailable: document.querySelectorAll('#ai-documents .source-unavailable').length,
                    cancelled: document.querySelectorAll('.status-cancelled').length,
                    incomplete: document.querySelectorAll('.status-incomplete').length,
                    conversationCount: document.querySelectorAll('.conversation').length,
                    messageIds: [...document.querySelectorAll('.message')].map((message) => message.id),
                    times: [...document.querySelectorAll('time')].map((time) => time.getAttribute('datetime')),
                    vocabulary: [...document.querySelectorAll('.vocabulary')].map((node) => node.textContent)
                }));
                for (const token of [
                    '/æl.fə/', 'SAVED_PART_OF_SPEECH', 'SAVED_WORD_MEANING', 'SAVED_GRAMMAR_ROLE', 'SAVED_WORD_USAGE',
                    'EXAMPLE_ONE_TRANSLATION', 'EXAMPLE_TWO_TRANSLATION', 'EXAMPLE_THREE', 'EXAMPLE_THREE_TRANSLATION', 'EXAMPLE_THREE_NOTE',
                    'PHRASE_IPA', 'SAVED_PHRASE_MEANING', 'SAVED_PHRASE_USAGE', 'PHRASE_EXAMPLE', 'PHRASE_TRANSLATION',
                    'FULL_SENTENCE_TRANSLATION', 'ALIGNMENT_ORIGINAL', 'ALIGNMENT_TRANSLATION', 'CHUNK_TEXT', 'CHUNK_ROLE', 'CHUNK_NOTE',
                    'KEY_POINT_ONE', 'KEY_POINT_TWO', 'PLAIN_STRING_EXPLANATION', 'SAVED_WORD_CONTEXT', 'SAVED_SENTENCE_CONTEXT',
                    'PERSONAL_NOTE', 'ARTICLE_NOTE_BODY', 'AI_DOCUMENT_BODY', 'HISTORICAL_USER_CONTENT 原文不轉換',
                    'SAVED_CANCELLED_REPLY', 'SAVED_PARTIAL_REPLY', 'SAVED_QUEUED_REPLY', 'SAVED_EMPTY_CONVERSATION'
                ]) assert.ok(actual.text.includes(token), token);
                for (const key of ['article.editionTitle', 'article.editionDetached', 'article.editionFirstViewed', 'article.editionLastViewed', 'article.editionLastOpened', 'article.editionLocalSnapshot', 'article.editionIncomplete', 'article.editionSyncError', 'article.editionUnderstandingReview', 'article.editionUnderstandingUnderstood', 'assistant.streamCancelled', 'article.readingExportCaveatPending', 'article.readingChatNotLoaded']) {
                    assert.notEqual(labels[key], key, `Missing dictionary label ${key}`);
                    assert.ok(actual.text.includes(labels[key]), key);
                }
                assert.equal(actual.cancelled, 1);
                assert.equal(actual.incomplete, 2);
                assert.equal(actual.conversationCount, 2);
                assert.deepEqual(actual.messageIds, ['message-1', 'message-2', 'message-3', 'message-4', 'message-5', 'message-6']);
                assert.equal(actual.docLinks.length, 2);
                assert.ok(actual.docLinks.some((href) => href.startsWith('#learning-')));
                assert.ok(actual.docLinks.includes('#message-4'));
                assert.equal(actual.unavailable, 3);
                assert.ok(actual.times.includes('2026-10-28T07:07:00.000Z'));
                assert.ok(actual.times.includes('2026-10-28T06:01:00.000Z'));
                assert.ok(actual.times.includes('2026-10-28T07:01:00.000Z'));
                assert.equal(actual.vocabulary.length, 2);
                assert.ok(actual.vocabulary.every((text) => text.includes('RELEVANT_BOOK <&>') && text.includes('SAVED_VOCABULARY_WORD')));
            });

            await check(`${locale}: script-free document blocks resource markup, unsafe links and private payloads`, async () => {
                const actual = await page.evaluate(() => ({
                    forbiddenTags: document.querySelectorAll('script,img,iframe,object,embed,form,input,button,textarea,select,link,base,svg,math,video').length,
                    eventAttributes: [...document.querySelectorAll('*')].flatMap((node) => [...node.attributes].filter((attribute) => /^on/i.test(attribute.name)).map((attribute) => attribute.name)),
                    outbound: [...document.querySelectorAll('a[href]:not([href^="#"])')].map((link) => ({ href: link.getAttribute('href'), target: link.target, rel: link.rel })),
                    csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content,
                    audio: [...document.querySelectorAll('audio')].map((audio) => ({ controls: audio.controls, autoplay: audio.autoplay, preload: audio.preload, paused: audio.paused, src: audio.querySelector('source').getAttribute('src') })),
                    text: document.body.textContent,
                    strong: document.querySelectorAll('.markdown strong').length,
                    table: document.querySelectorAll('.markdown table').length,
                    attack: window.EDITION_ATTACK
                }));
                assert.equal(actual.forbiddenTags, 0);
                assert.deepEqual(actual.eventAttributes, []);
                assert.equal(actual.attack, undefined);
                assert.ok(actual.csp.includes("default-src 'none'"));
                assert.ok(actual.csp.includes("script-src 'none'"));
                assert.ok(actual.csp.includes('media-src data:'));
                assert.ok(actual.outbound.length >= 4);
                for (const link of actual.outbound) {
                    assert.match(link.href, /^(https?:\/\/|mailto:|tel:)/);
                    assert.equal(link.target, '_blank');
                    assert.ok(link.rel.includes('noopener') && link.rel.includes('noreferrer'));
                    assert.ok(!/CREDENTIAL|PASSWORD_PRIVATE|javascript|should-never-open|\/\/resource\.invalid/.test(link.href));
                }
                assert.equal(actual.audio.length, 1);
                assert.equal(actual.audio[0].controls, true);
                assert.equal(actual.audio[0].autoplay, false);
                assert.equal(actual.audio[0].preload, 'none');
                assert.equal(actual.audio[0].paused, true);
                assert.ok(actual.audio[0].src.startsWith('data:audio/wav;base64,'));
                assert.equal(await page.locator('figcaption').textContent(), smallWave().name);
                assert.ok(actual.strong > 0);
                assert.equal(actual.table, 1);
                for (const token of ['AFTER_IMAGE_LINE', 'AFTER_INLINE_IMAGE', 'TRAILING_IMAGE_TEXT', '<script>window.EDITION_ATTACK=1</script>', '<script>literal saved example</script>']) assert.ok(actual.text.includes(token), token);
                for (const token of [
                    'EXCLUDED_', 'PROVENANCE_CREDENTIAL_PRIVATE', 'CREDENTIAL_IN_URL', 'ENCODED_CREDENTIAL_IN_URL', 'PASSWORD_PRIVATE', 'IMAGE_CREDENTIAL',
                    'article-A-private-id', 'item-one-private-id', 'account-private-scope', 'ai-doc-private-id', 'book-private-id'
                ]) assert.ok(!html.includes(token), `Leaked ${token}`);
                assert.ok(!actual.text.includes('article.edition'), 'Untranslated reading edition key');
            });

            await check(`${locale}: native marks navigate to cards and back with JavaScript disabled`, async () => {
                const mark = page.locator('.text-reference').first();
                const target = await mark.getAttribute('href');
                await mark.click();
                assert.equal(await page.evaluate(() => location.hash), target);
                assert.equal(await page.locator('.learning-card:target').count(), 1);
                const back = page.locator(`${target} .back-to-text`);
                const origin = await back.getAttribute('href');
                await back.click();
                assert.equal(await page.evaluate(() => location.hash), origin);
                assert.equal(await page.locator('.origin-target:target').count(), 1);
            });

            await check(`${locale}: desktop and mobile reading stays within viewport and attached audio decodes offline`, async () => {
                for (const width of [1280, 390, 320]) {
                    await page.setViewportSize({ width, height: 900 });
                    const layout = await page.evaluate(() => ({
                        width: document.documentElement.clientWidth,
                        contentWidth: document.documentElement.scrollWidth,
                        columns: getComputedStyle(document.querySelector('.records')).gridTemplateColumns,
                        font: parseFloat(getComputedStyle(document.querySelector('.original-text')).fontSize),
                        audioWidth: document.querySelector('audio').getBoundingClientRect().width
                    }));
                    assert.ok(layout.contentWidth <= layout.width + 1, `${width}px horizontal overflow: ${JSON.stringify(layout)}`);
                    assert.ok(layout.font >= 16);
                    assert.ok(layout.audioWidth > 0 && layout.audioWidth <= width);
                }
                const playable = await page.locator('audio').evaluate(async (audio) => {
                    audio.load();
                    await audio.play();
                    audio.pause();
                    return { duration: audio.duration, source: audio.currentSrc, error: audio.error?.code || 0 };
                });
                assert.equal(playable.error, 0);
                assert.ok(playable.duration > 0);
                assert.ok(playable.source.startsWith('data:audio/wav;base64,'));
            });
            await page.close();
        }
        assert.deepEqual(outboundRequests, []);

        await check('standalone parsing remains inert when JavaScript is enabled', async () => {
            const enabled = await browser.newContext();
            const requests = [];
            enabled.on('request', (request) => {
                if (!request.url().startsWith('data:')) requests.push(request.url());
            });
            await enabled.route('**/*', (route) => route.abort());
            const page = await enabled.newPage();
            const errors = [];
            page.on('pageerror', (error) => errors.push(String(error)));
            await page.setContent(outputs['zh-CN'].html, { waitUntil: 'load' });
            assert.equal(await page.evaluate(() => window.EDITION_ATTACK), undefined);
            assert.equal(await page.locator('script,[onerror],[onclick],[onload],img,iframe').count(), 0);
            assert.deepEqual(requests, []);
            assert.deepEqual(errors, []);
            await enabled.close();
        });

        await check('messages without IDs and malformed anchor metadata still retain saved content', async () => {
            const actual = await source.evaluate(() => {
                const { edition, snapshot, articleId, valid } = window.editionTest;
                const minimal = {
                    articleDoc: snapshot.articleDoc,
                    learningItems: [{ ...valid[0], id: 'unsafe-id-\"<&', anchor: { start: 0, end: 5, quote: '<img>' }, note: 'MALFORMED_ANCHOR_NOTE' }],
                    conversations: [{ articleId, id: 'safe-conversation', title: '<script>SAVED_TITLE</script>' }],
                    messages: [{ conversationId: 'safe-conversation', content: 'MISSING_ID_SAVED_MESSAGE', role: 'assistant', status: 'incomplete' }]
                };
                const { html, meta } = edition.renderReadingEdition({ snapshot: minimal, articleId });
                const doc = new DOMParser().parseFromString(html, 'text/html');
                return {
                    meta,
                    text: doc.body.textContent,
                    hasUnsafeId: !!doc.querySelector('[id*="unsafe-id"]'),
                    scriptTags: doc.querySelectorAll('script,img').length,
                    messageId: doc.querySelector('.message').id,
                    detachedCount: doc.querySelectorAll('#detached .learning-card').length
                };
            });
            assert.equal(actual.meta.messageCount, 1);
            assert.equal(actual.detachedCount, 1);
            assert.equal(actual.messageId, 'message-1');
            assert.equal(actual.hasUnsafeId, false);
            assert.equal(actual.scriptTags, 0);
            assert.ok(actual.text.includes('MALFORMED_ANCHOR_NOTE'));
            assert.ok(actual.text.includes('MISSING_ID_SAVED_MESSAGE'));
            assert.ok(actual.text.includes('<script>SAVED_TITLE</script>'));
        });

        await check('omitting chat removes messages and makes saved document sources explicitly unavailable', async () => {
            const actual = await source.evaluate(() => {
                const { edition, i18n, snapshot, articleId } = window.editionTest;
                i18n.setLocale('zh-CN', { persist: false });
                const output = edition.renderReadingEdition({ snapshot, articleId, includeChat: false, exportedAt: '2026-10-28T12:00:00.000Z' });
                const doc = new DOMParser().parseFromString(output.html, 'text/html');
                return {
                    meta: output.meta,
                    hasChat: !!doc.querySelector('#chat'),
                    missing: doc.querySelectorAll('#ai-documents .source-unavailable').length,
                    links: [...doc.querySelectorAll('#ai-documents .source-link')].map((link) => link.getAttribute('href')),
                    text: doc.body.textContent,
                    noAudio: i18n.t('article.editionNoAudio')
                };
            });
            assert.equal(actual.hasChat, false);
            assert.equal(actual.meta.conversationCount, 0);
            assert.equal(actual.meta.messageCount, 0);
            assert.equal(actual.meta.audioCount, 0);
            assert.equal(actual.missing, 4);
            assert.equal(actual.links.length, 1);
            assert.ok(!actual.text.includes('HISTORICAL_USER_CONTENT'));
            assert.ok(!actual.text.includes('SAVED_CANCELLED_REPLY'));
            assert.ok(actual.text.includes(actual.noAudio));
        });

        await check('a clean minimal snapshot stays empty and a prior error does not invent pending edits or opening times', async () => {
            const actual = await source.evaluate(() => {
                const { edition, i18n, snapshot, articleId } = window.editionTest;
                const clean = {
                    articleDoc: { id: articleId, body: '', title: '' },
                    articleOutboxCount: undefined,
                    readingOutboxCount: 'not-a-number'
                };
                const output = edition.renderReadingEdition({ snapshot: clean, articleId, exportedAt: 'invalid' });
                const failedSync = edition.renderReadingEdition({ snapshot: { ...clean, readingState: { lastError: 'PRIVATE_ERROR_DETAIL' } }, articleId });
                const missingSource = edition.renderReadingEdition({ snapshot: { ...clean, articleDoc: { ...clean.articleDoc, sourceUrl: 'https://user:SOURCE_PASSWORD@example.invalid/?token=SOURCE_TOKEN' } }, articleId });
                return {
                    meta: output.meta,
                    text: new DOMParser().parseFromString(output.html, 'text/html').body.textContent,
                    title: i18n.t('article.untitled'),
                    lastOpenedLabel: i18n.t('article.editionLastOpened'),
                    lastErrorMeta: failedSync.meta,
                    showsError: failedSync.html.includes(i18n.t('article.editionSyncError')),
                    showsPendingEdits: failedSync.html.includes(i18n.t('article.readingExportCaveatPending')),
                    rawError: failedSync.html.includes('PRIVATE_ERROR_DETAIL'),
                    sourceLeaks: /SOURCE_PASSWORD|SOURCE_TOKEN/.test(missingSource.html),
                    sourceOmitted: missingSource.html.includes(i18n.t('article.editionLinkOmitted')),
                    inputStillPresent: !!snapshot.learningItems.length
                };
            });
            for (const key of ['itemCount', 'documentCount', 'conversationCount', 'messageCount', 'audioCount', 'detachedCount', 'conflictCount']) assert.equal(actual.meta[key], 0, key);
            assert.equal(actual.meta.pending, false);
            assert.equal(actual.meta.title, actual.title);
            assert.ok(!actual.text.includes(actual.lastOpenedLabel));
            assert.equal(actual.lastErrorMeta.pending, true);
            assert.equal(actual.showsError, true);
            assert.equal(actual.showsPendingEdits, false);
            assert.equal(actual.rawError, false);
            assert.equal(actual.sourceLeaks, false);
            assert.equal(actual.sourceOmitted, true);
            assert.equal(actual.inputStillPresent, true);
        });
        assert.deepEqual(sourceErrors, []);
        console.log(`${results.length} reading edition browser checks passed; no external requests.`);
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
