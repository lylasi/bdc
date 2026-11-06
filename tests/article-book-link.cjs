/**
 * 文章 ↔ 詞書來源關聯與深連結的瀏覽器回歸。
 *
 * 執行（先開 python3 scripts/serve.py --port 8313）：
 *   PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/article-book-link.cjs
 *
 * 全部使用獨立 context 的合成資料；不連正式同步、AI 或帳戶。
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const PORT = Number(process.env.PORT || 8313);
const BASE = (process.env.BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '') + '/';
const failures = [];

function check(name, ok, detail) {
    if (ok) {
        console.log(`  ok   ${name}`);
        return true;
    }
    failures.push({ name, detail: detail === undefined ? '' : String(detail).slice(0, 600) });
    console.log(`  FAIL ${name}${detail === undefined ? '' : ' -- ' + String(detail).slice(0, 400)}`);
    return false;
}

function waitForInit(page) {
    return page.waitForEvent('console', {
        predicate: (message) => message.text().startsWith('应用程序已'),
        timeout: 20000
    });
}

async function gotoApp(page, hash) {
    const ready = waitForInit(page);
    await page.goto(BASE + (hash || ''), { waitUntil: 'domcontentloaded' });
    await ready;
    await page.evaluate(async () => {
        try { (await import('/modules/ui.js')).closeModal(); } catch (_) {}
    });
}

/** 設定 hash 後真正重新載入，驗證冷啟動深連結（同文件 goto 不會重跑初始化）。 */
async function reloadAt(page, hash) {
    await page.evaluate((value) => { location.hash = value; }, hash);
    const ready = waitForInit(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ready;
    await page.evaluate(async () => {
        try { (await import('/modules/ui.js')).closeModal(); } catch (_) {}
    });
}

async function newPage(browser, locale) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(({ locale }) => {
        try {
            const raw = localStorage.getItem('pen_global_settings');
            const parsed = raw ? JSON.parse(raw) : {};
            parsed.language = { ...(parsed.language || {}), interfaceLocale: locale };
            localStorage.setItem('pen_global_settings', JSON.stringify(parsed));
        } catch (_) {}
    }, { locale });
    await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith('/ai-config.js')) {
            return route.fulfill({
                contentType: 'application/javascript',
                body: 'export const SYNC={endpoint:""}; export const TTS_CONFIG={}, AI_LIMITS={}, OCR_CONFIG={}, ARTICLE_IMPORT={}, SUPABASE={};'
            });
        }
        return url.origin === BASE.slice(0, -1) ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error?.message || error)));
    page.on('console', (message) => {
        if (message.type() !== 'error') return;
        const text = message.text();
        if (/net::ERR|Failed to load resource|ERR_ABORTED|401|403|404|503|sync_endpoint_missing/i.test(text)) return;
        consoleErrors.push(text.slice(0, 300));
    });
    await gotoApp(page, '');
    return { context, page, pageErrors, consoleErrors };
}

async function seed(page) {
    const result = await page.evaluate(async () => {
        const art = await import('/modules/article-store.js');
        const reading = await import('/modules/reading-store.js');
        const state = await import('/modules/state.js');
        await art.initArticleStore();
        await reading.initReadingStore();
        const now = '2026-01-01T00:00:00.000Z';
        const articles = [
            {
                articleId: 'art_link_demo',
                article: '# Demo\n\nWe look forward to meeting you.',
                title: 'Demo Article',
                sourceType: 'url',
                sourceUrl: 'https://example.com/demo#section'
            },
            {
                articleId: 'art_link_by_url',
                article: '# URL only\n\nThe page link is explicit.',
                title: 'URL Article',
                sourceType: 'url',
                sourceUrl: 'https://example.com/url-only'
            },
            {
                articleId: 'art_link_new',
                article: '# Shared title\n\nThis article starts without a book.',
                title: 'Shared Title',
                sourceType: 'paste'
            },
            {
                articleId: 'art_link_unsafe',
                article: '# Unsafe source\n\nThe imported URL must not become a live link.',
                title: 'Unsafe Article',
                sourceType: 'url',
                sourceUrl: 'javascript:alert(1)'
            }
        ];
        for (const article of articles) {
            const saved = await art.saveArticle(article, { skipOutbox: true, touch: false });
            if (!saved.ok) throw new Error(`article ${article.articleId}: ${saved.error}`);
        }
        const books = [
            {
                id: 'book_link_demo', name: 'Demo Book', sourceType: 'article',
                articleId: 'art_link_demo', sourceUrl: 'https://example.com/demo#section',
                createdAt: now, updatedAt: now
            },
            {
                id: 'book_by_url', name: 'URL Book', sourceType: 'article',
                sourceUrl: 'https://example.com/url-only#fragment', createdAt: now, updatedAt: now
            },
            {
                id: 'book_name_only', name: 'Shared Title', sourceType: 'custom',
                createdAt: now, updatedAt: now
            },
            {
                id: 'book_unsafe', name: 'Unsafe Book', sourceType: 'article',
                articleId: 'art_link_unsafe', sourceUrl: 'javascript:alert(2)',
                createdAt: now, updatedAt: now
            },
            {
                id: 'book_external', name: 'External Book', sourceType: 'manual',
                sourceUrl: 'https://example.com/only-book', createdAt: now, updatedAt: now
            },
            {
                id: 'url:https%3A%2F%2Fexample.com%2Flegacy-page', name: 'Legacy URL Book', sourceType: 'article',
                sourceUrl: 'https://example.com/legacy-page', createdAt: now, updatedAt: now
            }
        ];
        for (const book of books) {
            const saved = await reading.upsertVocabularyBook(book);
            if (!saved.ok) throw new Error(`book ${book.id}: ${saved.error}`);
        }
        state.setVocabularyBooks(reading.vocabularyBooksForUi());
        return state.vocabularyBooks.length;
    });
    if (result !== 6) throw new Error(`expected 6 seeded books, got ${result}`);
}

async function waitArticle(page, text) {
    await page.waitForFunction(() => document.getElementById('article-section').classList.contains('active'));
    await page.waitForFunction((expected) => document.getElementById('article-input').value.includes(expected), text);
}

async function waitVocabulary(page) {
    await page.waitForFunction(() => document.getElementById('vocabulary-section').classList.contains('active'));
}

async function selectedBook(page) {
    return page.evaluate(() => document.getElementById('current-book-name').textContent.trim());
}

async function currentHash(page) {
    return page.evaluate(() => location.hash);
}

async function runLocale(browser, locale, { full }) {
    console.log(`\n[${locale}]`);
    const { context, page, pageErrors, consoleErrors } = await newPage(browser, locale);
    try {
        await seed(page);
        await reloadAt(page, '#v/book_link_demo');
        await waitVocabulary(page);
        check(`${locale} 直接開 #v/<bookId> 選中正確詞書`, (await selectedBook(page)) === 'Demo Book');
        check(`${locale} 深連結保留在網址`, (await currentHash(page)) === '#v/book_link_demo');
        const banner = await page.evaluate(() => {
            const root = document.querySelector('#current-book-meta .book-meta-banner');
            const origin = root?.querySelector('.book-origin-link');
            return {
                articleId: root?.dataset.bookArticleId || '',
                hasBack: !!root?.querySelector('.book-open-article-btn'),
                href: origin?.getAttribute('href') || ''
            };
        });
        check(`${locale} 詞書顯示安全原文來源`, banner.href === 'https://example.com/demo#section', banner.href);
        check(`${locale} 詞書可回文章`, banner.hasBack && banner.articleId === 'art_link_demo', JSON.stringify(banner));

        await page.click('.book-open-article-btn');
        await waitArticle(page, 'We look forward to meeting you.');
        check(`${locale} 回文章使用公開 articleId`, (await currentHash(page)) === '#a/art_link_demo');

        await page.click('#article-book-btn');
        await waitVocabulary(page);
        check(`${locale} 文章一鍵開既有詞書`, (await currentHash(page)) === '#v/book_link_demo' && (await selectedBook(page)) === 'Demo Book');

        if (full) {
            // 編輯來源網址時，javascript:/帳密網址必須在寫入前被擋下。
            await page.click('#edit-vocab-book-btn');
            await page.locator('#modal-book-source-url').waitFor({ state: 'visible', timeout: 8000 });
            await page.fill('#modal-book-source-url', 'javascript:alert(1)');
            await page.click('#app-modal .save-btn');
            await page.waitForFunction(() => document.querySelector('#message-container .message-toast'));
            const editState = await page.evaluate(async () => {
                const state = await import('/modules/state.js');
                return {
                    sourceUrl: state.vocabularyBooks.find((book) => book.id === 'book_link_demo')?.sourceUrl || '',
                    modalOpen: !document.getElementById('app-modal').classList.contains('hidden')
                };
            });
            check(`${locale} 非法來源網址不寫入詞書`, editState.sourceUrl === 'https://example.com/demo#section', JSON.stringify(editState));
            check(`${locale} 非法來源網址保留編輯彈窗`, editState.modalOpen, JSON.stringify(editState));
            await page.evaluate(async () => { (await import('/modules/ui.js')).closeModal(); });

            // 同名但沒有 articleId/sourceUrl 的詞書不得被誤配；文章應建立自己的詞書。
            await page.evaluate(() => { location.hash = '#a/art_link_new'; });
            await waitArticle(page, 'This article starts without a book.');
            const before = await page.evaluate(async () => {
                const state = await import('/modules/state.js');
                return state.vocabularyBooks.filter((book) => book.articleId === 'art_link_new').length;
            });
            check(`${locale} 無關聯文章尚未建立詞書`, before === 0, before);
            await page.click('#article-book-btn');
            await page.locator('#confirm-btn').waitFor({ state: 'visible', timeout: 8000 });
            await page.click('#confirm-btn');
            await waitVocabulary(page);
            const created = await page.evaluate(async () => {
                const state = await import('/modules/state.js');
                return {
                    matched: state.vocabularyBooks.filter((book) => book.articleId === 'art_link_new').length,
                    nameOnly: state.vocabularyBooks.find((book) => book.id === 'book_name_only') || null,
                    selected: state.activeBookId,
                    hash: location.hash
                };
            });
            check(`${locale} 無關聯時建立一本且只建立一本`, created.matched === 1, JSON.stringify(created));
            check(`${locale} 同名詞書沒有被誤綁`, !created.nameOnly?.articleId, JSON.stringify(created.nameOnly));
            check(`${locale} 建立後直接開啟新詞書`, created.selected === 'art_link_new' && created.hash === '#v/art_link_new', JSON.stringify(created));

            // 只有來源網址、沒有 articleId 的舊詞書仍能依同一頁回到文章。
            await page.evaluate(() => { location.hash = '#v/book_by_url'; });
            await waitVocabulary(page);
            check(`${locale} 舊詞書可用同頁網址回文章`, await page.locator('.book-open-article-btn').isVisible());
            await page.click('.book-open-article-btn');
            await waitArticle(page, 'The page link is explicit.');
            check(`${locale} 網址補關聯導向正確文章`, (await currentHash(page)) === '#a/art_link_by_url');

            // 不安全來源不得變成可點連結。
            await page.evaluate(() => { location.hash = '#v/book_unsafe'; });
            await waitVocabulary(page);
            check(`${locale} 不安全詞書來源不顯示連結`, (await page.locator('.book-origin-link').count()) === 0);
            await page.evaluate(() => { location.hash = '#a/art_link_unsafe'; });
            await waitArticle(page, 'The imported URL must not become a live link.');
            check(`${locale} 不安全文章來源不顯示連結`, await page.locator('#article-source-link').isHidden());

            // 外部來源詞書（無文章）只顯示來源，不顯示回文章。
            await page.evaluate(() => { location.hash = '#v/book_external'; });
            await waitVocabulary(page);
            check(`${locale} 外部詞書顯示原文來源`, (await page.locator('.book-origin-link').getAttribute('href')) === 'https://example.com/only-book');
            check(`${locale} 外部詞書不顯示回文章`, (await page.locator('.book-open-article-btn').count()) === 0);

            // 只改來源網址也要寫進永久層（不能因名稱未變而被略過）。
            await page.click('#edit-vocab-book-btn');
            await page.locator('#modal-book-source-url').waitFor({ state: 'visible', timeout: 8000 });
            await page.fill('#modal-book-source-url', 'https://example.com/external-updated');
            await page.click('#app-modal .save-btn');
            await page.waitForFunction(() => document.getElementById('app-modal').classList.contains('hidden'));
            await reloadAt(page, '#v/book_external');
            await waitVocabulary(page);
            check(`${locale} 外部詞書來源編輯可持久化`,
                (await page.locator('.book-origin-link').getAttribute('href')) === 'https://example.com/external-updated');

            // 舊網址文章的詞書 ID（url:...）也要能用 #v/ 深連結開啟。
            await page.evaluate(() => {
                location.hash = '#v/' + encodeURIComponent('url:https%3A%2F%2Fexample.com%2Flegacy-page');
            });
            await waitVocabulary(page);
            check(`${locale} 舊 url: 詞書 ID 可深連結`, (await selectedBook(page)) === 'Legacy URL Book');
            check(`${locale} 舊 url: 詞書連結保留`, (await currentHash(page)).startsWith('#v/url%3Ahttps%253A'));

            // 缺少詞書時保留深連結並提示；不得建立替代詞書。
            await page.evaluate(() => { location.hash = '#v/missing_book_xyz'; });
            await page.waitForFunction(() => document.getElementById('message-container')?.textContent?.trim().length > 0);
            check(`${locale} 缺書深連結保留網址`, (await currentHash(page)) === '#v/missing_book_xyz');
            check(`${locale} 缺書深連結有提示`, (await page.locator('#message-container .message-toast').count()) > 0);
        }
        check(`${locale} 沒有頁面例外`, pageErrors.length === 0, pageErrors.join(' | '));
        check(`${locale} 沒有非網路 console error`, consoleErrors.length === 0, consoleErrors.join(' | '));
    } finally {
        await context.close();
    }
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        await runLocale(browser, 'zh-CN', { full: true });
        await runLocale(browser, 'zh-HK', { full: false });
    } finally {
        await browser.close();
    }
    if (failures.length) {
        console.error(`\n${failures.length} failure(s):`);
        for (const failure of failures) console.error(`- ${failure.name}${failure.detail ? ` :: ${failure.detail}` : ''}`);
        process.exitCode = 1;
        return;
    }
    console.log('\nall checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
