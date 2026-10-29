/**
 * 學習記錄側欄：真實互動、雙語錯誤重試、刪除復原與跨分頁墓碑保護。
 * PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/reading-panel-improvements.cjs
 * ASSET_DIR 可選；只使用隔離 context、合成資料與攔截請求。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createReadingPanelFixture } = require('./helpers/reading-panel-fixture.cjs');

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ASSET_DIR = process.env.ASSET_DIR || '';
const results = [];
async function check(name, work) {
    await work();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
}
async function capture(page, name) {
    if (ASSET_DIR) await page.screenshot({ path: path.join(ASSET_DIR, name + '.png') });
}
const cards = page => page.locator('#reading-panel-list > .reading-item, #reading-panel-list > .reading-doc');
const card = (page, id) => page.locator(`[data-item-id="${id}"]`);
async function expand(page, id) {
    const button = card(page, id).locator('[data-action="expand"]');
    if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
}
async function settle(page, count = 13) {
    await page.waitForFunction(count => document.querySelector('#reading-panel-list')?.getAttribute('aria-busy') === 'false'
        && document.querySelectorAll('#reading-panel-list > article').length === count, count);
}

async function testStore(page, fixture) {
    const outcome = await page.evaluate(async fixture => {
        const rd = await import('/modules/reading-store.js');
        const actions = await import('/modules/reading-actions.js');
        const item = rd.getLearningItem(fixture.ids[3]);
        const target = { articleId: item.articleId, kind: item.kind, quote: item.anchor.quote, sentence: item.sentence, anchor: item.anchor, contentVersion: item.contentVersion, data: { analysis: { meaning: 'Synthetic recheck' } } };
        const oldContext = { ...actions.captureActionContext(), startedAt: '2000-01-01T00:00:00.000Z' };
        const deletion = await rd.deleteLearningItem(item.id);
        const background = await actions.recordExplanation({ ...target, markViewed: false });
        const oldResponse = await actions.recordExplanation({ ...target, markViewed: true, actionContext: oldContext });
        const opAfterBackground = (await rd.listOutbox()).find(op => op.entityId === item.id)?.op;
        const restored = await actions.recordExplanation({ ...target, markViewed: true, actionContext: {
            ...actions.captureActionContext(), startedAt: new Date(Date.parse(deletion.entity.deletedAt) + 1).toISOString()
        } });
        const opAfterRestore = (await rd.listOutbox()).find(op => op.entityId === item.id)?.op;
        const permanent = await import('/modules/permanent-db.js');
        const stale = [];
        for (const [type, id, storeName] of [
            ['learningItem', item.id, permanent.STORE.READING_ITEMS],
            ['articleDocument', fixture.noteId, permanent.STORE.ARTICLE_DOCUMENTS]
        ]) {
            const deleted = type === 'learningItem' ? await rd.deleteLearningItem(id) : await rd.deleteArticleDocument(id);
            const latestAt = new Date(Date.parse(deleted.entity.deletedAt) + 1000).toISOString();
            const latest = { ...deleted.entity, deletedAt: latestAt, revision: 9, ...(type === 'learningItem' ? { note: 'Newer persisted note' } : { content: 'Newer persisted document' }) };
            // 模擬另一分頁已提交，但本分頁記憶體仍停在舊墓碑。
            const written = await permanent.applyPermanentOperations([{ store: storeName, type: 'put', value: latest }]);
            if (!written.ok) throw new Error(written.error);
            const restore = type === 'learningItem'
                ? await rd.restoreLearningItem(id, deleted.entity.deletedAt)
                : await rd.restoreArticleDocument(id, deleted.entity.deletedAt);
            stale.push({ type, restore });
            await rd.ensureArticleReadingLoaded(fixture.articleId);
            const final = type === 'learningItem'
                ? await rd.restoreLearningItem(id, latestAt)
                : await rd.restoreArticleDocument(id, latestAt);
            stale.at(-1).final = final;
        }
        const legacy = await rd.upsertLearningItem({
            id: 'legacy_random_occurrence', articleId: fixture.articleId, contentVersion: fixture.version,
            kind: 'word', anchor: actions.resolveAnchor(fixture.articleId, 'Friday'), sentence: 'Please review the attached document before Friday.', note: 'Legacy note'
        });
        await rd.deleteLearningItem(legacy.entity.id);
        const legacyRestored = await actions.recordExplanation({
            articleId: fixture.articleId, contentVersion: fixture.version, kind: 'word', quote: 'Friday', anchor: legacy.entity.anchor,
            sentence: legacy.entity.sentence, data: { analysis: { meaning: 'Friday' } }, markViewed: true
        });
        const legacyDeleted = await rd.deleteLearningItem(legacy.entity.id);
        const explicit = await actions.ensureItem({
            articleId: fixture.articleId, contentVersion: fixture.version, kind: 'word', quote: 'Friday',
            anchor: legacy.entity.anchor, sentence: legacy.entity.sentence, actionContext: {
                ...actions.captureActionContext(), startedAt: new Date(Date.parse(legacyDeleted.entity.deletedAt) + 1).toISOString()
            }
        });
        await rd.deleteLearningItem(legacy.entity.id);
        return { deletion, background, oldResponse, opAfterBackground, restored, opAfterRestore, stale, legacyRestored, explicit };
    }, fixture);
    assert.ok(outcome.deletion.ok);
    assert.ok(outcome.background.entity.deletedAt);
    assert.ok(outcome.oldResponse.entity.deletedAt, 'an answer started before deletion must not restore');
    assert.equal(outcome.opAfterBackground, 'delete');
    assert.equal(outcome.restored.entity.id, fixture.ids[3]);
    assert.equal(outcome.restored.entity.deletedAt, '');
    assert.equal(outcome.opAfterRestore, 'upsert');
    for (const item of outcome.stale) {
        assert.equal(item.restore.error, 'stale_delete', JSON.stringify(item));
        assert.equal(item.final.entity.deletedAt, '', JSON.stringify(item));
        assert.equal(item.final.entity.revision, 9);
        assert.equal(item.type === 'learningItem' ? item.final.entity.note : item.final.entity.content,
            item.type === 'learningItem' ? 'Newer persisted note' : 'Newer persisted document');
    }
    assert.equal(outcome.legacyRestored.entity.id, 'legacy_random_occurrence');
    assert.equal(outcome.legacyRestored.entity.note, 'Legacy note');
    assert.equal(outcome.explicit.entity.deletedAt, '');
    assert.equal(outcome.explicit.entity.id, 'legacy_random_occurrence');
}

async function runLocale(browser, locale) {
    const { context, page, fixture, errors } = await createReadingPanelFixture(browser, { locale });
    try {
        await check(`${locale}: counts, search and saved intersection`, async () => {
            assert.equal(await cards(page).count(), 13);
            assert.equal(await page.locator('[data-filter="all"] .reading-filter-count').innerText(), '13');
            await page.locator('[data-filter="notes"]').click();
            assert.equal(await cards(page).count(), 3);
            await page.locator('[data-filter="all"]').click();
            await page.locator('#reading-saved-only').check();
            assert.equal(await cards(page).count(), 1);
            assert.equal(await page.locator('.reading-doc').count(), 0);
            await page.locator('#reading-saved-only').uncheck();
            await page.locator('#reading-search').fill('budget');
            assert.equal(await cards(page).count(), 2);
            assert.equal(await page.locator('[data-filter="all"] .reading-filter-count').innerText(), '2');
            await page.locator('#reading-search').fill('no-such-record-827');
            await page.locator('#reading-clear-filters').click();
            assert.equal(await cards(page).count(), 13);
            assert.equal(await page.locator('#reading-search').inputValue(), '');
            await page.locator('#reading-sort').selectOption('viewed');
            assert.ok(await cards(page).first().getAttribute('data-item-id'));
            await page.locator('#reading-sort').selectOption('source');
        });
        await check(`${locale}: desktop layout and original text locate`, async () => {
            const layout = await page.evaluate(() => {
                const reader = document.querySelector('.analysis-result').getBoundingClientRect();
                const sheet = document.querySelector('.reading-panel-sheet').getBoundingClientRect();
                return { width: reader.width, gap: sheet.x - reader.right, modal: document.getElementById('article-reading-panel').getAttribute('aria-modal') };
            });
            assert.ok(layout.width >= 500 && layout.gap >= 0, JSON.stringify(layout));
            assert.equal(layout.modal, 'false');
            await card(page, fixture.ids[0]).locator('[data-action="locate"]').click();
            assert.ok(await page.locator('#article-reading-panel').isVisible());
            await capture(page, `${locale}-desktop`);
        });
        await check(`${locale}: draft failure, retry feedback and close flush`, async () => {
            await expand(page, fixture.ids[0]);
            await page.evaluate(async () => {
                window.__panelSaveFails = true;
                (await import('/modules/reading-actions.js')).__setNoteSaveInterceptorForTests(() => window.__panelSaveFails ? { ok: false, error: 'synthetic_failure' } : null);
            });
            const note = page.locator(`[data-note-id="${fixture.ids[0]}"]`);
            const text = `Draft ${locale} 保留原始筆記`;
            await note.fill(text);
            await page.locator(`[data-note-retry="${fixture.ids[0]}"]`).waitFor();
            await page.locator('.reading-panel-close').click();
            assert.ok(await page.locator('#article-reading-panel').isVisible());
            assert.equal(await note.inputValue(), text);
            await page.evaluate(() => { window.__panelSaveFails = false; });
            await page.locator(`[data-note-retry="${fixture.ids[0]}"]`).click();
            await page.waitForFunction(async ({ id, text }) => {
                const { t } = await import('/modules/i18n.js');
                const rd = await import('/modules/reading-store.js');
                return rd.getLearningItem(id)?.note === text
                    && document.querySelector(`[data-note-status="${id}"]`)?.textContent === t('article.readingSaved')
                    && document.activeElement?.getAttribute('data-note-id') === id;
            }, { id: fixture.ids[0], text });
            await note.fill(text + ' final');
            await page.locator('.reading-panel-close').click();
            await page.locator('#article-reading-panel.hidden').waitFor({ state: 'attached' });
            assert.equal(await page.evaluate(async id => (await import('/modules/reading-store.js')).getLearningItem(id).note, fixture.ids[0]), text + ' final');
            await page.locator('#article-reading-records-btn').click();
            await settle(page);
        });
        await check(`${locale}: mouse retry keeps the click target and returns focus to the note`, async () => {
            const id = fixture.ids[3];
            for (const width of [1440, 390]) {
                await page.setViewportSize({ width, height: 844 });
                await expand(page, id);
                await page.evaluate(() => { window.__panelSaveFails = true; });
                const note = page.locator(`[data-note-id="${id}"]`);
                const text = `Mouse retry ${locale} ${width}`;
                await note.fill(text);
                const retry = page.locator(`[data-note-retry="${id}"]`);
                await retry.waitFor();
                assert.ok(await note.evaluate(el => el === document.activeElement));
                await page.evaluate(() => { window.__panelSaveFails = false; });
                await retry.hover();
                await page.mouse.down();
                await page.waitForTimeout(100);
                assert.ok(await retry.evaluate(el => el === document.activeElement), 'retry remains focused until mouseup');
                await page.mouse.up();
                await page.waitForFunction(async ({ id, text }) => {
                    const { t } = await import('/modules/i18n.js');
                    const rd = await import('/modules/reading-store.js');
                    return rd.getLearningItem(id)?.note === text
                        && document.querySelector(`[data-note-status="${id}"]`)?.textContent === t('article.readingSaved')
                        && document.activeElement?.getAttribute('data-note-id') === id;
                }, { id, text });
            }
            await page.setViewportSize({ width: 1440, height: 844 });
            await page.locator('#reading-search').focus();
        });
        await check(`${locale}: tools are clickable and backup entry downloads JSON`, async () => {
            await page.locator('.reading-tools > summary').click();
            await page.locator('#reading-export-json').click();
            const backup = page.locator('.reading-export-dialog');
            await backup.waitFor();
            assert.equal(await backup.locator('input[data-option-key="fullBackup"], .radio-group').count(), 0);
            const downloading = page.waitForEvent('download');
            await page.locator('.options-modal-overlay #confirm-btn').click();
            const file = await downloading;
            assert.match(file.suggestedFilename(), /\.json$/);
            const content = await fs.readFile(await file.path(), 'utf8');
            const backupData = JSON.parse(content);
            assert.equal(backupData.kind, 'bdc-full-backup');
            assert.ok(backupData.payload.articleDocuments.some(doc => doc.id === fixture.articleId));
            assert.ok(await page.locator('#article-reading-panel').isVisible());
            assert.ok(await page.evaluate(() => !!document.activeElement?.closest('#article-reading-panel')));
        });
        await check(`${locale}: document Markdown and linked source record`, async () => {
            await page.locator('[data-filter="ai"]').click();
            const doc = page.locator(`[data-doc-id="${fixture.aiId}"]`);
            await doc.locator('summary').click();
            assert.equal(await doc.locator('.reading-doc-content h2').innerText(), '用法');
            assert.equal(await doc.locator('.reading-doc-content script').count(), 0);
            assert.equal(await page.evaluate(() => !!window.__unsafeReadingMarkdown), false);
            await doc.locator('[data-source-item]').click();
            assert.equal(await card(page, fixture.ids[0]).locator('[data-action="expand"]').getAttribute('aria-expanded'), 'true');
            assert.equal(await page.locator(`[data-note-id="${fixture.ids[0]}"]`).evaluate(el => document.activeElement === el), true);
            await page.locator('#reading-search').focus();
        });
        await check(`${locale}: delete cancel, delete and durable undo for item and document`, async () => {
            for (const [type, id] of [['item', fixture.ids[0]], ['document', fixture.noteId]]) {
                const target = type === 'item' ? card(page, id) : page.locator(`[data-doc-id="${id}"]`);
                if (type === 'item') await expand(page, id);
                else await target.locator('summary').click();
                const remove = target.locator(type === 'item' ? '[data-action="delete"]' : '[data-doc-action="delete"]');
                await remove.click();
                await page.locator('.options-modal-overlay #cancel-btn').click();
                assert.equal(await target.count(), 1);
                await remove.click();
                await page.locator('.options-modal-overlay #confirm-btn').click();
                await page.locator('#reading-undo-delete').waitFor();
                assert.equal(await target.count(), 0);
                await page.locator('#reading-undo-delete').click();
                await target.waitFor();
                assert.equal(await cards(page).count(), 13);
            }
        });
        await check(`${locale}: loading, read failure and retry distinguish unavailable data`, async () => {
            await page.evaluate(async () => {
                const original = IDBIndex.prototype.getAll;
                window.__panelOriginalGetAll = original;
                IDBIndex.prototype.getAll = function (...args) {
                    if (this.name === 'scope_article' && this.objectStore.name === 'reading_items') throw new Error('synthetic_read_failure');
                    return original.apply(this, args);
                };
                await (await import('/modules/reading-store.js')).reloadReadingScope();
            });
            await page.locator('#reading-load-retry').waitFor();
            assert.equal(await page.locator('[data-filter="all"] .reading-filter-count').innerText(), '—');
            const expected = await page.evaluate(async () => (await import('/modules/i18n.js')).t('article.readingLoadFailed'));
            assert.ok((await page.locator('#reading-panel-list').innerText()).includes(expected));
            await capture(page, `${locale}-read-error`);
            const loading = await page.evaluate(() => {
                IDBIndex.prototype.getAll = window.__panelOriginalGetAll;
                document.getElementById('reading-load-retry').click();
                return document.querySelector('#reading-panel-list').getAttribute('aria-busy');
            });
            assert.equal(loading, 'true');
            await settle(page);
        });
        await check(`${locale}: closed and open tools wrap Tab and Shift+Tab within the panel`, async () => {
            for (const width of [390, 1024]) {
                await page.setViewportSize({ width, height: 844 });
                const first = page.locator('.reading-panel-close');
                const summary = page.locator('.reading-tools > summary');
                await page.locator('.reading-tools').evaluate(el => { el.open = false; });
                await summary.focus();
                await page.keyboard.press('Tab');
                assert.ok(await first.evaluate(el => el === document.activeElement));
                await page.keyboard.press('Shift+Tab');
                assert.ok(await summary.evaluate(el => el === document.activeElement));
                await summary.click();
                await page.locator('#reading-ai-notes').focus();
                await page.keyboard.press('Tab');
                assert.ok(await first.evaluate(el => el === document.activeElement));
                await page.keyboard.press('Shift+Tab');
                assert.ok(await page.locator('#reading-ai-notes').evaluate(el => el === document.activeElement));
                await page.keyboard.press('Escape');
                assert.ok(await summary.evaluate(el => el === document.activeElement));
                assert.ok(await page.locator('#article-reading-panel').isVisible());
            }
        });
        await check(`${locale}: phone and tablet child dialogs, keyboard trap, locate return`, async () => {
            for (const width of [1024, 834, 390, 320]) {
                await page.setViewportSize({ width, height: 844 });
                await page.locator('#reading-article-note').click();
                const editor = page.locator('#reading-article-note-input');
                await editor.fill(`Full note ${locale} ${width}`);
                await page.locator('#reading-article-note-save').click();
                await page.locator('#app-modal.hidden').waitFor({ state: 'attached' });
                assert.ok(await page.locator('#article-reading-panel').isVisible());
                await page.locator('.reading-tools > summary').click();
                await page.locator('#reading-ai-notes').click();
                await page.locator('#reading-ai-cancel').click();
                await page.locator('#reading-article-note').click();
                await page.keyboard.press('Escape');
                assert.equal(await page.locator('#app-modal').isVisible(), false);
                assert.ok(await page.locator('#article-reading-panel').isVisible());
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
                assert.equal(await page.locator('#article-reading-panel').getAttribute('aria-modal'), 'true');
                if (width === 390 || width === 834) await capture(page, `${locale}-${width}`);
            }
            await page.setViewportSize({ width: 390, height: 844 });
            await page.locator('.reading-panel-close').focus();
            for (let i = 0; i < 45; i += 1) {
                await page.keyboard.press('Tab');
                assert.ok(await page.evaluate(() => !!document.activeElement?.closest('#article-reading-panel')));
            }
            await page.locator('[data-filter="words"]').click();
            await card(page, fixture.ids[4]).locator('[data-action="locate"]').click();
            assert.equal(await page.locator('#article-reading-panel').isVisible(), false);
            await page.locator('#reading-return').click();
            assert.equal(await page.locator('[data-filter="words"]').getAttribute('aria-pressed'), 'true');
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('#article-reading-panel').isVisible(), false);
            assert.equal(await page.evaluate(() => [...document.body.children].some(el => el.inert)), false);
            assert.equal(await page.locator('#article-reading-records-btn').evaluate(el => el === document.activeElement), true);
            await page.locator('#article-reading-records-btn').click();
            await settle(page, 10);
            await page.locator('[data-filter="all"]').click();
        });
        await check(`${locale}: active recheck restores, old replies and stale undo preserve tombstones`, () => testStore(page, fixture));
        await check(`${locale}: source conversation opens existing assistant without sending`, async () => {
            await page.locator('[data-filter="ai"]').click();
            const doc = page.locator(`[data-doc-id="${fixture.aiId}"]`);
            if (!await doc.locator('details').evaluate(el => el.open)) await doc.locator('summary').click();
            await doc.locator('[data-doc-action="conversation"]').click();
            await page.waitForFunction(() => document.getElementById('assistant-panel')?.textContent.includes('Synthetic saved explanation.'));
            assert.equal(await page.locator('#article-reading-panel').isVisible(), false);
            const messages = await page.evaluate(async () => (await import('/modules/reading-store.js')).getMessages('conv_panel'));
            assert.equal(messages.length, 1);
            await page.locator('#assistant-close').click();
            await page.locator('#article-reading-records-btn').click();
            await settle(page, 1);
            await page.locator('[data-filter="all"]').click();
        });
        await check(`${locale}: AI summary uses mock provider and preserves source records`, async () => {
            const mock = require('./helpers/article-mock.cjs');
            await mock.installProviderRoutes(page, ({ route }) => mock.jsonReply(route, '## Synthetic summary\n\nSaved from the selected records.'));
            await page.evaluate(async () => {
                const { loadAIProfile, saveAIProfile } = await import('/modules/ai-profile-storage.js');
                const profile = loadAIProfile();
                profile.taskModels.articleAnalysis = 'mock:mock-model';
                saveAIProfile(profile);
            });
            const before = await page.evaluate(async articleId => (await import('/modules/reading-store.js')).listLearningItems(articleId).map(item => ({ id: item.id, note: item.note, marked: item.marked })), fixture.articleId);
            await page.locator('.reading-tools > summary').click();
            await page.locator('#reading-ai-notes').click();
            await page.locator('#reading-ai-run').click();
            await page.locator('#app-modal.hidden').waitFor({ state: 'attached' });
            const generated = await page.evaluate(async articleId => {
                const rd = await import('/modules/reading-store.js');
                return {
                    itemState: rd.listLearningItems(articleId).map(item => ({ id: item.id, note: item.note, marked: item.marked })),
                    docs: rd.listArticleDocuments(articleId, { withContent: true })
                };
            }, fixture.articleId);
            assert.deepEqual(generated.itemState, before);
            const doc = generated.docs.find(doc => doc.content.includes('Synthetic summary'));
            assert.ok(doc?.sourceItemIds.length === 11);
            assert.ok(await page.locator('#article-reading-panel').isVisible());
        });
        assert.deepEqual(errors, [], `${locale} page errors`);
    } finally { await context.close(); }
}

(async () => {
    if (ASSET_DIR) await fs.mkdir(ASSET_DIR, { recursive: true });
    const browser = await chromium.launch({ headless: true, executablePath: CHROME });
    try {
        for (const locale of ['zh-CN', 'zh-HK']) await runLocale(browser, locale);
        console.log(`\n${results.length} checks passed`);
    } finally {
        await browser.close();
        if (ASSET_DIR) await fs.writeFile(path.join(ASSET_DIR, 'results.json'), JSON.stringify(results, null, 2) + '\n');
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
