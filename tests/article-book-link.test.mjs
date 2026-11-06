// 文章 ↔ 詞書來源關聯的純函式與深連結契約。
// 執行：node --test tests/article-book-link.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    articleIdentityIds,
    safeHttpSourceUrl,
    matchVocabularyBookForArticle,
    matchArticleForVocabularyBook
} from '../shared/article-book-link.mjs';
import {
    readVocabularyRoute,
    isValidVocabularyBookId,
    vocabBookHash
} from '../modules/vocabulary-route.js';

test('article identity includes public id, storage id and aliases', () => {
    const ids = articleIdentityIds({
        articleId: 'url:https%3A%2F%2Fexample.com%2Fa',
        storageId: 'art_internal_1',
        referenceIds: ['art_internal_1', 'legacy_alias']
    });
    assert.deepEqual([...ids].sort(), ['art_internal_1', 'legacy_alias', 'url:https%3A%2F%2Fexample.com%2Fa'].sort());
});

test('article finds a book by the same stable id first', () => {
    const result = matchVocabularyBookForArticle(
        { articleId: 'art_1', title: 'Same name' },
        [{ id: 'art_1', name: 'Book' }]
    );
    assert.equal(result.book?.id, 'art_1');
    assert.equal(result.match, 'articleId');
    assert.equal(result.ambiguous, false);
});

test('article finds a book whose articleId points at a storage alias', () => {
    const result = matchVocabularyBookForArticle(
        { articleId: 'url:https%3A%2F%2Fexample.com%2Fa', storageId: 'art_internal_1' },
        [
            { id: 'book_unrelated', articleId: 'art_other' },
            { id: 'book_page', articleId: 'art_internal_1' }
        ]
    );
    assert.equal(result.book?.id, 'book_page');
    assert.equal(result.match, 'articleId');
});

test('explicit linkedBookId wins over an older articleId association', () => {
    const result = matchVocabularyBookForArticle(
        { articleId: 'art_1', linkedBookId: 'book_preferred' },
        [
            { id: 'book_old', articleId: 'art_1', createdAt: '2020-01-01T00:00:00.000Z' },
            { id: 'book_preferred' }
        ]
    );
    assert.equal(result.book?.id, 'book_preferred');
    assert.equal(result.match, 'linkedBookId');
});

test('exact page URL fallback ignores ordinary fragments but keeps hash routes', () => {
    const byFragment = matchVocabularyBookForArticle(
        { articleId: 'art_1', sourceUrl: 'https://example.com/read#section' },
        [{ id: 'book_fragment', sourceUrl: 'https://example.com/read' }]
    );
    assert.equal(byFragment.book?.id, 'book_fragment');
    assert.equal(byFragment.match, 'sourceUrl');

    const routeOne = matchVocabularyBookForArticle(
        { articleId: 'art_1', sourceUrl: 'https://example.com/read#/lesson/1' },
        [{ id: 'book_two', sourceUrl: 'https://example.com/read#/lesson/2' }]
    );
    assert.equal(routeOne.book, null);

    const routeSame = matchVocabularyBookForArticle(
        { articleId: 'art_1', sourceUrl: 'https://example.com/read#/lesson/1' },
        [{ id: 'book_one', sourceUrl: 'https://example.com/read#/lesson/1' }]
    );
    assert.equal(routeSame.book?.id, 'book_one');
});

test('same display name alone never creates an article/book link', () => {
    const result = matchVocabularyBookForArticle(
        { articleId: 'art_1', title: 'Shared Title', sourceUrl: '' },
        [{ id: 'book_custom', name: 'Shared Title', sourceType: 'custom' }]
    );
    assert.equal(result.book, null);
    assert.equal(result.match, 'none');
});

test('duplicate page books are deterministic and marked ambiguous', () => {
    const result = matchVocabularyBookForArticle(
        { articleId: 'art_1', sourceUrl: 'https://example.com/page' },
        [
            { id: 'book_late', sourceUrl: 'https://example.com/page', createdAt: '2024-01-02T00:00:00.000Z' },
            { id: 'book_early', sourceUrl: 'https://example.com/page', createdAt: '2024-01-01T00:00:00.000Z' }
        ]
    );
    assert.equal(result.book?.id, 'book_early');
    assert.equal(result.ambiguous, true);
});

test('soft-deleted books are ignored', () => {
    const result = matchVocabularyBookForArticle(
        { articleId: 'art_1' },
        [{ id: 'art_1', deletedAt: '2024-01-01T00:00:00.000Z' }]
    );
    assert.equal(result.book, null);
});

test('book finds its article by articleId or by sharing the same id', () => {
    const articles = [{ articleId: 'art_1', title: 'A', sourceType: 'url', sourceUrl: 'https://example.com/a' }];
    const byField = matchArticleForVocabularyBook({ id: 'book_a', articleId: 'art_1' }, { articles });
    assert.equal(byField.article?.articleId, 'art_1');
    assert.equal(byField.match, 'articleId');

    const bySameId = matchArticleForVocabularyBook({ id: 'art_1' }, { articles });
    assert.equal(bySameId.article?.articleId, 'art_1');
});

test('book finds the public article when it stored the internal storage id', () => {
    const articles = [{
        articleId: 'url:https%3A%2F%2Fexample.com%2Flegacy',
        storageId: 'art_storage_9',
        title: 'Legacy'
    }];
    const result = matchArticleForVocabularyBook({ id: 'webbook_1', articleId: 'art_storage_9' }, { articles });
    assert.equal(result.article?.articleId, 'url:https%3A%2F%2Fexample.com%2Flegacy');
    assert.equal(result.articleId, 'url:https%3A%2F%2Fexample.com%2Flegacy');
});

test('book without articleId falls back to the same page URL only', () => {
    const articles = [{ articleId: 'art_1', sourceUrl: 'https://example.com/p#section' }];
    const byUrl = matchArticleForVocabularyBook({ id: 'book_page', sourceUrl: 'https://example.com/p' }, { articles });
    assert.equal(byUrl.article?.articleId, 'art_1');
    assert.equal(byUrl.match, 'sourceUrl');

    const byNameOnly = matchArticleForVocabularyBook(
        { id: 'book_page', name: 'Article title' },
        { articles: [{ articleId: 'art_1', title: 'Article title', sourceUrl: '' }] }
    );
    assert.equal(byNameOnly.article, null);
});

test('article meta linkedBookId can point back to a book without articleId', () => {
    const metas = [{ id: 'meta_1', linkedBookId: 'book_meta', title: 'From meta' }];
    const result = matchArticleForVocabularyBook({ id: 'book_meta' }, { metas });
    assert.equal(result.article?.id, 'meta_1');
    assert.equal(result.match, 'linkedBookId');
});

test('soft-deleted articles are ignored', () => {
    const result = matchArticleForVocabularyBook(
        { id: 'book_a', articleId: 'art_1', sourceUrl: 'https://example.com/a' },
        { articles: [{ articleId: 'art_1', sourceUrl: 'https://example.com/a', deletedAt: '2024-01-01T00:00:00.000Z' }] }
    );
    assert.equal(result.article, null);
});

test('safe source URLs only allow credential-free http(s)', () => {
    assert.equal(safeHttpSourceUrl('https://example.com/a'), 'https://example.com/a');
    assert.equal(safeHttpSourceUrl('javascript:alert(1)', 'https://example.com/b'), 'https://example.com/b');
    assert.equal(safeHttpSourceUrl('ftp://example.com/a'), '');
    assert.equal(safeHttpSourceUrl('https://user@example.com/a'), '');
    assert.equal(safeHttpSourceUrl('data:text/html,hi'), '');
    assert.equal(safeHttpSourceUrl('javascript:alert(1)'), '');
});

test('vocabulary deep link parses #v, #vocab and #vocabulary', () => {
    assert.deepEqual(readVocabularyRoute('#v'), { id: '', invalid: false });
    assert.deepEqual(readVocabularyRoute('#v/'), { id: '', invalid: false });
    assert.deepEqual(readVocabularyRoute('#v/art_1'), { id: 'art_1', invalid: false });
    assert.deepEqual(readVocabularyRoute('#vocab/webbook_a'), { id: 'webbook_a', invalid: false });
    assert.deepEqual(readVocabularyRoute('#/vocabulary/book-1'), { id: 'book-1', invalid: false });
    assert.equal(readVocabularyRoute('#a/art_1'), null);
    assert.equal(readVocabularyRoute('#v/art_1/extra').invalid, true);
    assert.deepEqual(readVocabularyRoute('#v/%E0%A4%A'), { id: '', invalid: true });
    assert.equal(readVocabularyRoute('#v/hello world').invalid, true);
});

test('vocabulary deep link keeps legacy url: book ids round-trippable', () => {
    const bookId = 'url:https%3A%2F%2Fexample.com%2Farticle';
    assert.equal(isValidVocabularyBookId(bookId), true);
    const hash = vocabBookHash(bookId);
    assert.equal(hash, '#v/url%3Ahttps%253A%252F%252Fexample.com%252Farticle');
    assert.deepEqual(readVocabularyRoute(hash), { id: bookId, invalid: false });
});

test('vocabulary bare route remains #v for existing navigation', () => {
    assert.equal(vocabBookHash(''), '#v');
    assert.equal(vocabBookHash('art_1'), '#v/art_1');
});
