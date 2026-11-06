const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { chromium } = require('/Users/linus/.local/share/fnm/node-versions/v24.20.0/installation/lib/node_modules/@playwright/cli/node_modules/playwright');
const meta = JSON.parse(fs.readFileSync(path.join(__dirname, 'release-info.json'), 'utf8'));
meta.worktree = path.resolve(__dirname, '../../../..');
meta.assets = __dirname;
const root = meta.worktree;
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const imports = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]).imports;
const mapped = new Set([...Object.keys(imports), '/styles.css', '/main.js']);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const existingOutput = path.join(meta.assets, 'online-verification.json');
const outputs = fs.existsSync(existingOutput) ? JSON.parse(fs.readFileSync(existingOutput, 'utf8')) : [];
(async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        for (const base of (process.env.BDC_VERIFY_SITE ? [process.env.BDC_VERIFY_SITE] : ['http://10.10.10.149:8001', 'https://bdc.a4a4.qzz.io'])) {
            for (const locale of ['zh-CN', 'zh-HK']) {
                const targetOrigin = new URL(base).origin;
                const context = await browser.newContext({ viewport: locale === 'zh-HK' ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
                const page = await context.newPage();
                const checks = [];
                const pageErrors = [];
                const hashes = new Map();
                const pending = [];
                const bodyReadErrors = [];
                const check = (name, condition, detail) => {
                    checks.push({ name, ok: !!condition, ...(detail === undefined ? {} : { detail }) });
                    assert.ok(condition, base + ' ' + locale + ': ' + name + ' ' + JSON.stringify(detail));
                };
                page.on('pageerror', error => pageErrors.push(error.message));
                page.on('response', response => {
                    const url = new URL(response.url());
                    if (url.origin !== targetOrigin || !(mapped.has(url.pathname) || url.pathname === '/')) return;
                    pending.push((async () => {
                        const bytes = await response.body();
                        const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
                        hashes.set(url.pathname + url.search, { file: relative, status: response.status(), sha256: sha256(bytes), expected: sha256(fs.readFileSync(path.join(root, relative))), release: url.searchParams.get('v') });
                    })().catch(error => { bodyReadErrors.push({ url: response.url(), status: response.status(), error: error.message }); }));
                });
                await context.route('**/*', route => {
                    const url = new URL(route.request().url());
                    if (url.pathname === '/ai-config.js') return route.fulfill({ contentType: 'application/javascript', body: 'export const SYNC={endpoint:""},TTS_CONFIG={},AI_LIMITS={},OCR_CONFIG={},ARTICLE_IMPORT={},SUPABASE={};' });
                    if (url.origin !== targetOrigin) return route.abort();
                    return route.continue();
                });
                await context.addInitScript(locale => {
                    localStorage.setItem('vocabImportPromptShown', '1');
                    if (!localStorage.getItem('pen_global_settings')) localStorage.setItem('pen_global_settings', JSON.stringify({ language: { interfaceLocale: locale } }));
                }, locale);
                const ready = page.waitForEvent('console', { predicate: message => message.text().startsWith('应用程序已'), timeout: 30000 });
                await page.goto(base + '/', { waitUntil: 'load', timeout: 45000 });
                const initialized = await ready;
                check('application initializes fully', initialized.text() === '应用程序已完全初始化。', initialized.text());
                await page.waitForFunction(async () => (await import('/modules/reading-store.js')).isReadingMigrated(), { timeout: 15000 });
                check('deployed HTML uses new release', await page.locator('script[type="importmap"]').textContent().then(text => text.includes(meta.release)));
                await page.evaluate(async () => {
                    const state = await import('/modules/state.js');
                    const storage = await import('/modules/storage.js');
                    state.setVocabularyBooks([{ id: 'online-source-check', name: 'Source display check', sourceType: 'custom', words: [
                        { id: 'online-rebranded', word: 'Rebranded', phonetic: 'riːˈbændɪd', meaning: '重新命名的', sources: [{ sourceUrl: 'https://example.com/article', pageTitle: 'Example article', sentence: 'The company rebranded its services.', context: 'The new name was announced today.' }] },
                        { id: 'online-infiltrate', word: 'infiltrate', meaning: '滲入、滲透', sources: [{ sourceUrl: 'https://example.com/news', sentence: 'The group attempted to infiltrate the network.' }] }
                    ] }]);
                    const result = await storage.saveVocabularyBooks();
                    if (!result.ok) throw new Error(result.error);
                    state.setActiveBookId('online-source-check');
                    storage.saveAppState();
                    (await import('/features/vocabulary/vocabulary.js')).refreshVocabularyView();
                    (await import('/modules/ui.js')).closeModal();
                });
                check('localized UI loaded', await page.locator('html').getAttribute('lang') === locale);
                await page.locator('.word-sources').first().waitFor({ state: 'visible' });
                check('sources default to visible', await page.locator('.word-sources').count() === 2);
                const compact = await page.locator('.word-sources').first().evaluate(el => ({ width: el.getBoundingClientRect().width, height: el.firstElementChild.getBoundingClientRect().height, border: getComputedStyle(el).borderWidth }));
                check('source entry is compact', compact.width < 100 && compact.height === 28 && compact.border === '0px', compact);
                await page.locator('#vocab-words-panel').screenshot({ path: path.join(meta.assets, (base.startsWith('https') ? 'public-' : 'lan-') + locale + '-sources.png') });
                await page.locator('.word-sources summary').first().focus();
                await page.keyboard.press('Enter');
                check('keyboard expansion shows original sentence', await page.locator('.word-source').first().innerText().then(text => text.includes('The company rebranded its services.')));
                check('original link retained', await page.locator('.word-source a').first().getAttribute('href') === 'https://example.com/article');
                const openSettings = async () => {
                    await page.locator('#app-gear-btn').click();
                    await page.locator('#gm-settings').click();
                    await page.locator('[data-gs-tab="general"]').click();
                };
                await openSettings();
                const label = locale === 'zh-HK' ? '顯示單字來源' : '显示单词来源';
                check('new setting localized', await page.locator('label:has(#gs-vocabulary-sources)').innerText() === label);
                await page.locator('label:has(#gs-vocabulary-sources)').click();
                check('hide applies immediately', await page.locator('.word-sources').count() === 0);
                check('preference saved locally', await page.evaluate(() => JSON.parse(localStorage.getItem('pen_global_settings')).vocabulary.showSources === false));
                await page.locator('#app-modal .modal-content').screenshot({ path: path.join(meta.assets, (base.startsWith('https') ? 'public-' : 'lan-') + locale + '-settings.png') });
                await page.locator('#gs-save').click();
                const reloaded = page.waitForEvent('console', { predicate: message => message.text().startsWith('应用程序已'), timeout: 30000 });
                await page.reload({ waitUntil: 'load' });
                await reloaded;
                await page.locator('#word-list .word-item').first().waitFor();
                check('reload preserves hidden preference', await page.locator('.word-sources').count() === 0 && await page.locator('#word-list .word-item').count() === 2);
                await openSettings();
                check('setting remains unchecked', !(await page.locator('#gs-vocabulary-sources').isChecked()));
                await page.locator('label:has(#gs-vocabulary-sources)').click();
                await page.locator('#gs-save').click();
                check('show restores sources', await page.locator('.word-sources').count() === 2);
                check('source data preserved', await page.evaluate(async () => (await import('/modules/state.js')).vocabularyBooks[0].words.every(word => word.sources.length === 1)));
                check('mobile has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
                const responseResults = await Promise.allSettled(pending);
                check('all release assets available for verification', responseResults.every(item => item.status === 'fulfilled') && hashes.size === 99, { count: hashes.size, bodyReadErrors });
                const assets = [...hashes.values()];
                check('loaded assets match committed source', assets.length === 99 && assets.every(item => item.status === 200 && item.sha256 === item.expected), { count: assets.length, mismatched: assets.filter(item => item.status !== 200 || item.sha256 !== item.expected) });
                check('all loaded modules and CSS use new release', assets.filter(item => item.file !== 'index.html').every(item => item.release === meta.release));
                check('no JavaScript exceptions', pageErrors.length === 0, pageErrors);
                const result = { base, locale, passed: checks.length, checks, assets, bodyReadErrors, pageErrors };
                outputs.push(result);
                fs.writeFileSync(path.join(meta.assets, 'online-verification.json'), JSON.stringify(outputs, null, 2) + '\n');
                console.log('PASS ' + base + ' ' + locale + ': ' + checks.length + ' checks, ' + assets.length + ' loaded assets match source');
                await context.close();
            }
        }
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
