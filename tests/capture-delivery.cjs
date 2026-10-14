/**
 * 產出交付用截圖：4 個視窗 × 2 語言，涵蓋詞書 / 學習 / 聽寫 / 文章 / OCR / 問答 / 測驗
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const path = require('path');
const PORT = process.env.PORT || 8313;
const BASE = `http://127.0.0.1:${PORT}/`;
const OUT = path.resolve(__dirname, '..', 'docs', 'report', 'assets-ui-redesign');
fs.mkdirSync(OUT, { recursive: true });

const books = [{
    id: 'audit-book',
    name: '五年级 · Daily words',
    words: [
        { id: 'audit-apple', word: 'apple', meaning: '苹果', phonetic: 'ˈæpl' },
        { id: 'audit-book-word', word: 'notebook', meaning: '笔记本', phonetic: 'ˈnəʊtbʊk' }
    ]
}];
const PAGES = [['vocabulary', '词汇'], ['learning', 'learning'], ['dictation', 'dictation'], ['article', 'article'], ['ocr', 'ocr'], ['qa', 'qa'], ['quiz', 'quiz']];

(async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const written = [];
    try {
        for (const locale of ['zh-CN', 'zh-HK']) {
            for (const [width, height] of [[390, 844], [768, 1024], [1024, 768], [1440, 900]]) {
                const context = await browser.newContext({ viewport: { width, height } });
                await context.route('**/*', (r) => new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort());
                await context.addInitScript(({ books, locale }) => {
                    localStorage.setItem('vocabularyBooks', JSON.stringify(books));
                    localStorage.setItem('activeBookId', 'audit-book');
                    localStorage.setItem('vocabImportPromptShown', '1');
                    localStorage.setItem('pen_global_settings', JSON.stringify({ language: { interfaceLocale: locale }, assistant: { enabled: false } }));
                    let t; const s = window.speechSynthesis;
                    s.speak = (u) => { s.cancel(); u.onstart?.(); t = setTimeout(() => u.onend?.(), 150); };
                    s.cancel = () => clearTimeout(t);
                }, { books, locale });
                const page = await context.newPage();
                await page.goto(BASE, { waitUntil: 'load' });
                await page.waitForTimeout(500);
                for (const [alias, label] of PAGES) {
                    await page.goto(`${BASE}?module=${alias}`, { waitUntil: 'load' });
                    await page.waitForTimeout(450);
                    const file = path.join(OUT, `deepseek-r2-${locale}-${width}x${height}-${label}.png`);
                    await page.screenshot({ path: file, animations: 'disabled' });
                    written.push(path.relative(path.resolve(__dirname, '..'), file));
                }
                await context.close();
            }
        }
    } finally { await browser.close(); }
    console.log(JSON.stringify({ count: written.length, dir: path.relative(path.resolve(__dirname, '..'), OUT) }, null, 2));
})();
