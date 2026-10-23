/**
 * 長文樣本產生器（P0-T1 共用）。
 *
 * 10k／50k 字文章不入版控：測試在需要時用這個模組現場組字串，
 * 也讓 Phase 3 的長文量測腳本可以重跑同一份樣本。
 */

const SENTENCE_POOL = [
    'The reading room keeps a small shelf of dictionaries beside the window.',
    'Students often copy a sentence twice before they trust their memory.',
    'A quiet hour in the morning is worth two noisy hours after lunch.',
    'The librarian marks each returned book with a paper slip and a date.',
    'Some words look simple until the same word appears in a different context.',
    'A short note in the margin can save a long search later in the week.',
    'Readers who write down questions tend to remember the answers longer.',
    'The bus stops in front of the library and leaves every twelve minutes.'
];

function sentenceAt(index) {
    return SENTENCE_POOL[index % SENTENCE_POOL.length];
}

/**
 * 產生指定段數、每段約 wordsPerParagraph 字的英文文章。
 * @param {{ paragraphs?: number, sentencesPerParagraph?: number }} options
 * @returns {string}
 */
function buildArticle({ paragraphs = 10, sentencesPerParagraph = 4 } = {}) {
    const blocks = [];
    for (let p = 0; p < paragraphs; p += 1) {
        const sentences = [];
        for (let s = 0; s < sentencesPerParagraph; s += 1) {
            sentences.push(sentenceAt(p * sentencesPerParagraph + s));
        }
        blocks.push(sentences.join(' '));
    }
    return blocks.join('\n\n');
}

/**
 * 產生「約 n 字」的樣本（以段落切分，避免超長單段）。
 * @param {number} chars
 * @param {{ paragraphs?: number }} options
 */
function buildArticleOfLength(chars, { paragraphs = 20 } = {}) {
    const body = buildArticle({ paragraphs, sentencesPerParagraph: 4 });
    const parts = [];
    let length = 0;
    while (length < chars) {
        const chunk = body.slice(0, Math.min(body.length, chars - length));
        parts.push(chunk);
        length += chunk.length + 2;
    }
    return parts.join('\n\n');
}

module.exports = {
    SENTENCE_POOL,
    buildArticle,
    buildArticleOfLength,
    TEN_K_CHARS: 10000,
    FIFTY_K_CHARS: 50000
};
