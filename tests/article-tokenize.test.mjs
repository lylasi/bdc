/**
 * 文章詳解 P3-T4：語言感知分詞（純函式）單元測試。
 *
 * 覆蓋：
 *   - 重音、直／彎撇號、連字號、詞內數字、前後標點、網址、小數、中文混排、emoji
 *   - token 的 start/end 必須能還原原文（錨點／朗讀不得被分詞改寫）
 *   - Intl.Segmenter 缺失時的 fallback regex 必須給出相同結果
 *   - trimTokenEdge／isTokenizableChar／shouldSkipNode 的邊界行為
 *
 * 不需要 DOM、不需要瀏覽器：
 *   node --test tests/article-tokenize.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    segmentWords,
    shouldSkipNode,
    isTokenizableChar,
    trimTokenEdge
} from '../features/article/tokenize.js';

const wordsOf = (text, options) => segmentWords(text, options).map((token) => token.word);

/**
 * [原文, 期望詞序列]
 * 期望只列「會被包成查詞 token」的詞；標點、空白、emoji、純數字都不在內。
 */
const SAMPLES = [
    ['café', ['café']],
    ['naïve', ['naïve']],
    ["don't", ["don't"]],
    ['O’Neill', ['O’Neill']],
    ['co-operate', ['co-operate']],
    ['COVID-19', ['COVID-19']],
    ['B2B', ['B2B']],
    ['3D', ['3D']],
    ['3D-printed parts', ['3D-printed', 'parts']],
    ['B2B-commerce works', ['B2B-commerce', 'works']],
    ['state-of-the-art design', ['state-of-the-art', 'design']],
    ['well-known author', ['well-known', 'author']],
    ['l’école is open', ['l’école', 'is', 'open']],
    ['rock’n’roll band', ['rock’n’roll', 'band']],
    ['the résumé is ready', ['the', 'résumé', 'is', 'ready']],
    ['Zürich and Māui', ['Zürich', 'and', 'Māui']],
    ['U.S.A. is large', ['U.S.A', 'is', 'large']],
    ['five p.m. sharp', ['five', 'p.m', 'sharp']],
    ['e.g. this', ['e.g', 'this']],
    ['(café), naïve!', ['café', 'naïve']],
    ['Price 3.14 dollars', ['Price', 'dollars']],
    ['Version 2.0.1 shipped', ['Version', 'shipped']],
    ['Visit https://example.com/a.b. now', ['Visit', 'https', 'example.com', 'a.b', 'now']],
    ['email me@example.com today', ['email', 'me', 'example.com', 'today']],
    ['dogs’ bark', ['dogs', 'bark']],
    ['—dash— here', ['dash', 'here']],
    ['COVID‑19 notices', ['COVID‑19', 'notices']],
    ['Hello 👋 world', ['Hello', 'world']],
    ['Hello...world', ['Hello', 'world']],
    ['中文 mixed 3D', ['中文', 'mixed', '3D']],
    ['中文café 3D', ['中文', 'café', '3D']]
];

/** 暫時移除 Intl.Segmenter，強制走 fallback。 */
function withoutSegmenter(fn) {
    const original = Intl.Segmenter;
    Intl.Segmenter = undefined;
    try {
        assert.equal(typeof Intl.Segmenter, 'undefined', 'Intl.Segmenter 必須可被暫時移除');
        return fn();
    } finally {
        Intl.Segmenter = original;
    }
}

test('segmentWords：至少 20 個語言樣本（重音／撇號／連字號／數字／標點／網址／小數）', () => {
    assert.ok(SAMPLES.length >= 20, `樣本數 ${SAMPLES.length} 應 >= 20`);
    for (const [text, expected] of SAMPLES) {
        assert.deepEqual(wordsOf(text), expected, `segmentWords(${JSON.stringify(text)})`);
    }
});

test('segmentWords：offsets 可從原文切片還原，且互不重疊', () => {
    for (const [text] of SAMPLES) {
        const tokens = segmentWords(text);
        let cursor = 0;
        for (const token of tokens) {
            assert.equal(typeof token.start, 'number');
            assert.equal(typeof token.end, 'number');
            assert.ok(token.start >= cursor, `${JSON.stringify(text)} token 起點不得重疊`);
            assert.ok(token.end > token.start, `${JSON.stringify(text)} token 必須有長度`);
            assert.equal(text.slice(token.start, token.end), token.word, `${JSON.stringify(text)} offset 必須對回原文`);
            assert.match(token.word, /\p{L}/u, `${JSON.stringify(text)} token 必須含字母`);
            cursor = token.end;
        }
    }
});

test('segmentWords：不會把純數字、小數與網址尾點留在詞內', () => {
    assert.deepEqual(wordsOf('2020 2021'), []);
    assert.deepEqual(wordsOf('3.14 2.0.1'), []);
    const urlTokens = wordsOf('See https://example.com/a.b. now');
    assert.ok(!urlTokens.some((word) => word.endsWith('.')), JSON.stringify(urlTokens));
    assert.ok(urlTokens.includes('example.com'), JSON.stringify(urlTokens));
    assert.ok(!urlTokens.includes('example'), JSON.stringify(urlTokens));
    assert.ok(!urlTokens.includes('com'), JSON.stringify(urlTokens));
});

test('segmentWords：中文混排與 emoji 只切出可查詞，offsets 仍對回原文', () => {
    const text = '中文 mixed 3D 👋 再見';
    const tokens = segmentWords(text);
    assert.deepEqual(tokens.map((token) => token.word).filter((word) => /\p{L}/u.test(word) && !/\p{Script=Han}/u.test(word)), ['mixed', '3D']);
    for (const token of tokens) {
        assert.equal(text.slice(token.start, token.end), token.word);
        // 不得把中文與拉丁字母黏成同一個 token
        assert.ok(!(/\p{Script=Han}/u.test(token.word) && /[A-Za-z]/.test(token.word)), token.word);
    }
    assert.deepEqual(wordsOf('😀 🎉'), []);
});

test('segmentWords：Intl.Segmenter 缺失時 fallback 給出相同結果', () => {
    withoutSegmenter(() => {
        for (const [text, expected] of SAMPLES) {
            assert.equal(typeof Intl.Segmenter, 'undefined');
            assert.deepEqual(wordsOf(text), expected, `fallback segmentWords(${JSON.stringify(text)})`);
        }
    });
});

test('segmentWords：fallback 仍保留 offset 與尾端標點處理', () => {
    withoutSegmenter(() => {
        const text = 'Visit https://example.com/a.b. now';
        const tokens = segmentWords(text);
        assert.deepEqual(tokens.map((token) => token.word), ['Visit', 'https', 'example.com', 'a.b', 'now']);
        for (const token of tokens) assert.equal(text.slice(token.start, token.end), token.word);
        // 還原原文：token 之間只會少掉標點／空白，不會吃掉字母
        let cursor = 0;
        for (const token of tokens) {
            assert.ok(token.start >= cursor);
            cursor = token.end;
        }
    });
});

test('segmentWords：非法／空輸入安全', () => {
    assert.deepEqual(segmentWords(''), []);
    assert.deepEqual(segmentWords(null), []);
    assert.deepEqual(segmentWords(undefined), []);
    assert.deepEqual(segmentWords('   '), []);
    assert.deepEqual(segmentWords('... !!! ???'), []);
});

test('segmentWords：locale 參數可傳入且不影響英文結果', () => {
    assert.deepEqual(wordsOf('café naïve', { locale: 'zh-HK' }), ['café', 'naïve']);
    assert.deepEqual(wordsOf('café naïve', { locale: 'en' }), ['café', 'naïve']);
});

test('trimTokenEdge：只去掉詞邊緣標點，不動詞內符號', () => {
    assert.equal(trimTokenEdge('café,'), 'café');
    assert.equal(trimTokenEdge('...hello...'), 'hello');
    assert.equal(trimTokenEdge('U.S.A.'), 'U.S.A');
    assert.equal(trimTokenEdge('3.14'), '3.14');
    assert.equal(trimTokenEdge('-done-'), 'done');
    assert.equal(trimTokenEdge('dogs’'), 'dogs');
    assert.equal(trimTokenEdge('（naïve）'), 'naïve');
    assert.equal(trimTokenEdge(''), '');
    assert.equal(trimTokenEdge(null), '');
    assert.equal(trimTokenEdge('...'), '');
});

test('isTokenizableChar：字母／組合符號／數字可入詞，標點與空白不可', () => {
    for (const char of ['a', 'Z', 'é', 'ï', 'ü', '中', '9', '\u0301']) {
        assert.equal(isTokenizableChar(char), true, `應可入詞：${char}`);
    }
    for (const char of ['.', '-', '’', "'", ' ', '\n', ',', '!', '@', '👋']) {
        assert.equal(isTokenizableChar(char), false, `不應入詞：${char}`);
    }
    assert.equal(isTokenizableChar(''), false);
});

test('shouldSkipNode：語義節點與 null 安全', () => {
    // 用最小 stub 檢查 selector 內容，不需要 DOM。
    const stub = (nodeType, token) => {
        const calls = [];
        const node = {
            nodeType,
            calls,
            closest(selector) {
                calls.push(selector);
                const parts = String(selector).split(',').map((part) => part.trim());
                return parts.includes(token) ? { nodeType: 1, token } : null;
            }
        };
        if (nodeType === 3) node.parentElement = { nodeType: 1, closest: node.closest };
        return node;
    };

    for (const selector of ['a', 'code', 'pre', 'kbd', 'samp', 'script', 'style', 'textarea',
        '.sent-analyze-btn', '.interactive-word', '.md-image', '[data-no-word-wrap]']) {
        assert.equal(shouldSkipNode(stub(1, selector)), true, `應跳過 ${selector}`);
        // 文字節點以其 parent 判定
        assert.equal(shouldSkipNode(stub(3, selector)), true, `文字節點應跳過 ${selector}`);
    }

    assert.equal(shouldSkipNode(null), false);
    assert.equal(shouldSkipNode(undefined), false);
    assert.equal(shouldSkipNode(stub(1, 'span')), false);
    assert.equal(shouldSkipNode({ nodeType: 3, parentElement: null }), false);
    // 檢查 selector 真的有涵蓋所有語義節點
    const probe = stub(1, 'span');
    shouldSkipNode(probe);
    const selector = probe.calls[probe.calls.length - 1];
    for (const token of ['a', 'code', 'pre', 'kbd', 'samp', 'script', 'style', 'textarea',
        '.sent-analyze-btn', '.interactive-word', '.md-image', '[data-no-word-wrap]']) {
        assert.ok(selector.includes(token), `selector 缺少 ${token}`);
    }
});
