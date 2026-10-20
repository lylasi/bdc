const { chromium } = require('/Users/linus/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
const fs = require('node:fs');
const path = require('node:path');
const BASE = 'http://127.0.0.1:8313';
const checks = [];
const check = (name, pass, detail) => {
    checks.push({ name, pass: !!pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`, detail === undefined ? '' : JSON.stringify(detail));
};
const fixture = {
    articleId: 'art_independent_marks',
    title: 'Repeated words',
    body: 'We look forward to meeting you.\n\nWe look forward to meeting you.',
    sentence: 'We look forward to meeting you.'
};
async function init(page) {
    await page.goto(BASE);
    await page.waitForTimeout(900);
    await page.evaluate(async () => {
        document.querySelector('#app-modal .modal-close-btn')?.click();
        const a = await import('/modules/article-store.js');
        const r = await import('/modules/reading-store.js');
        const act = await import('/modules/reading-actions.js');
        const p = await import('/modules/permanent-db.js');
        const proto = await import('/shared/reading-protocol.mjs');
        await a.initArticleStore();
        await r.initReadingStore();
        window.review = { a, r, act, p, proto };
    });
}
async function read(page, id) {
    return page.evaluate(async (id) => {
        const { p, r } = window.review;
        const db = await p.openPermanentDb();
        return new Promise((resolve, reject) => {
            const req = db.transaction(p.STORE.READING_ITEMS).objectStore(p.STORE.READING_ITEMS).index('scope').getAll(r.getReadingScope());
            req.onsuccess = () => resolve(req.result.find(item => item.id === id));
            req.onerror = () => reject(req.error);
        });
    }, id);
}
(async () => {
    const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    try {
        const context = await browser.newContext();
        await context.route('**/*', route => {
            const url = new URL(route.request().url());
            if (url.pathname.endsWith('/ai-config.js')) return route.fulfill({ contentType: 'application/javascript', body: 'export const SYNC={endpoint:""};export const TTS_CONFIG={},AI_LIMITS={},OCR_CONFIG={},ARTICLE_IMPORT={},SUPABASE={};' });
            if (url.origin !== BASE) return route.abort();
            return route.continue();
        });
        const first = await context.newPage();
        await init(first);
        const items = await first.evaluate(async (f) => {
            const { a, r, act } = window.review;
            const saved = await a.saveArticle({ articleId: f.articleId, article: f.body, title: f.title, sourceType: 'paste' });
            if (!saved.ok) throw new Error(saved.error);
            const out = [];
            for (const start of [3, f.body.lastIndexOf('look')]) {
                const result = await act.ensureItem({ articleId: f.articleId, kind: 'word', quote: 'look', sentence: f.sentence, anchor: { start, end: start + 4, quote: 'look' } });
                if (!result.ok) throw new Error(result.error);
                out.push(result.entity);
            }
            return out;
        }, fixture);
        check('same word at two positions has distinct items', items[0].id !== items[1].id);
        check('new lookup/note targets start unmarked', items.every(item => item.marked === false));
        const second = await context.newPage();
        await init(second);
        await second.evaluate(async (articleId) => { await window.review.r.ensureArticleReadingLoaded(articleId); }, fixture.articleId);
        await first.evaluate(async (id) => {
            const result = await window.review.act.saveNote(id, 'Newest note from the other tab');
            if (!result.ok) throw new Error(result.error);
        }, items[1].id);
        const book = { id: 'book_independent_marks', name: 'Review book' };
        const entry = { id: 'entry_independent_look', bookId: book.id, word: 'look', meaning: '看', examples: [], sources: [] };
        const link = { id: 'link_independent_look', itemId: items[1].id, bookId: book.id, entryId: entry.id };
        const added = await second.evaluate(async payload => window.review.r.addVocabularyEntryWithLink(payload), { book, entry, item: items[1], link });
        check('stale tab add-to-book transaction succeeds', added.ok, added.error);
        let latest = await read(first, items[1].id);
        check('stale tab add preserves newest note and marks selected position', latest.marked === true && latest.note === 'Newest note from the other tab', { marked: latest.marked, note: latest.note });
        check('adding repeated word does not mark first occurrence', (await read(first, items[0].id)).marked === false);
        await second.evaluate(async (id) => window.review.act.setMarked(id, false), items[1].id);
        await first.evaluate(async ({ f, item }) => {
            const { act } = window.review;
            await act.saveNote(item.id, 'Note updated after cancellation');
            await act.recordExplanation({ articleId: f.articleId, kind: 'word', quote: 'look', sentence: f.sentence, anchor: item.anchor, data: { word: 'look', analysis: { meaning: '看' } }, markViewed: true });
        }, { f: fixture, item: items[1] });
        latest = await read(first, items[1].id);
        check('note update and repeat lookup preserve explicit false', latest.marked === false && latest.note === 'Note updated after cancellation' && !!latest.lastViewedAt, { marked: latest.marked, note: latest.note });
        const stillLinked = await second.evaluate((id) => window.review.r.listVocabularyLinks({ itemId: id }).length, items[1].id);
        check('unmark keeps vocabulary association', stillLinked === 1, stillLinked);
        await second.reload();
        await init(second);
        await second.evaluate(async id => window.review.r.ensureArticleReadingLoaded(id), fixture.articleId);
        check('refresh keeps explicit false despite vocabulary link', (await read(second, items[1].id)).marked === false);
        const readded = await second.evaluate(async payload => window.review.r.addVocabularyEntryWithLink(payload), { book, entry, item: items[1], link });
        latest = await read(first, items[1].id);
        check('deliberate duplicate add marks again while preserving note', readded.ok && latest.marked === true && latest.note === 'Note updated after cancellation');
        await second.evaluate(async id => window.review.r.removeVocabularyEntry(id), entry.id);
        latest = await read(first, items[1].id);
        check('removing vocabulary entry preserves mark and note', latest.marked === true && latest.note === 'Note updated after cancellation');
        // A legacy missing field plus one failed migration write must be retryable
        // without reloading the page or clearing local data.
        await first.evaluate(async (id) => {
            const { p, r } = window.review;
            const record = await r.getEntity('learningItem', id);
            delete record.marked;
            record.understanding = 'needs_review';
            await p.applyPermanentOperations([{ store: p.STORE.READING_ITEMS, type: 'put', value: record }]);
            await r.initReadingStore();
            const original = IDBObjectStore.prototype.put;
            window.review.restorePut = () => { IDBObjectStore.prototype.put = original; };
            IDBObjectStore.prototype.put = function (value, ...args) {
                if (this.name === 'reading_items' && value.id === id && typeof value.marked === 'boolean') {
                    throw new DOMException('Injected migration failure', 'QuotaExceededError');
                }
                return original.call(this, value, ...args);
            };
        }, items[0].id);
        const failedMigration = await first.evaluate(async id => window.review.r.ensureArticleReadingLoaded(id), fixture.articleId);
        await first.evaluate(() => window.review.restorePut());
        const retriedMigration = await first.evaluate(async id => window.review.r.ensureArticleReadingLoaded(id), fixture.articleId);
        latest = await read(first, items[0].id);
        check('legacy migration failure is reported and retried', failedMigration.ok === false && retriedMigration.ok === true && latest.marked === true, { failedMigration, retriedMigration, marked: latest.marked });
        // Public link-only use remains supported for restored/pre-existing items.
        const linkOnly = await first.evaluate(async payload => window.review.r.addVocabularyEntryWithLink(payload), {
            book,
            entry: { ...entry, id: 'entry_independent_link_only' },
            item: null,
            link: { ...link, id: 'link_independent_link_only', itemId: items[0].id, entryId: 'entry_independent_link_only' }
        });
        const links = await first.evaluate(id => window.review.r.listVocabularyLinks({ itemId: id }), items[0].id);
        check('existing item link-only API preserves association', linkOnly.ok && links.some(x => x.id === 'link_independent_link_only'), { ok: linkOnly.ok, links: links.map(x => x.id) });
        await context.close();
    } finally {
        await browser.close();
        if (process.env.ASSET_DIR) {
            fs.mkdirSync(process.env.ASSET_DIR, { recursive: true });
            fs.writeFileSync(path.join(process.env.ASSET_DIR, 'independent-mark-review.json'), JSON.stringify(checks, null, 2));
        }
    }
    if (checks.some(x => !x.pass)) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
