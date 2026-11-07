/** Regression: slowly move from a wrapped sentence into its reading popover. */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { setup, count, last, finish, screenshot } = require('./article-sentence-reading.cjs');

const PREFIX = 'That makes them potential kingmakers.';
const SENTENCE = 'However, all but one of the Jewish parties pledged before the polls not to work with them in government.';
const TRANSLATION = '然而，除了一个犹太政党外，所有犹太政党在投票前都承诺，不会与他们合作组建政府。';
const placements = new Set();

async function runCase(browser, locale, width) {
    const { page, context, errors } = await setup(browser, locale, width);
    try {
        await page.evaluate(async ({ prefix, sentence, translation }) => {
            const articles = await import('/modules/article-store.js');
            const saved = await articles.saveArticle({
                articleId: 'art_hover_path', title: 'Wrapped sentence hover', article: `${prefix} ${sentence}`, sourceType: 'paste',
                result: { chinese_translation: translation, word_alignment: [], detailed_analysis: [],
                    paragraph_analysis: [{ chinese_translation: translation,
                        sentences: [{ en: prefix, zh: '这让他们可能成为关键力量。' }, { en: sentence, zh: translation }] }],
                    sentence_analysis: [], phrase_analysis: [] }
            });
            if (!saved.ok) throw new Error(saved.error);
            (await import('/modules/state.js')).setCurrentArticleId('art_hover_path');
            await (await import('/features/article/article.js')).showCurrentArticleIfAvailable();
        }, { prefix: PREFIX, sentence: SENTENCE, translation: TRANSLATION });
        const geometry = await page.evaluate(() => {
            const pair = document.querySelector('.paragraph-pair');
            const sentence = pair.querySelectorAll('.interactive-sentence')[1];
            const trigger = pair.querySelectorAll('.sent-analyze-btn')[1];
            const available = pair.parentElement.getBoundingClientRect().width;
            for (let width = Math.min(760, Math.floor(available)); width >= 320; width -= 4) {
                pair.style.maxWidth = `${width}px`;
                const box = pair.getBoundingClientRect();
                const button = trigger.getBoundingClientRect();
                if (sentence.getClientRects().length >= 2 && button.left - box.left < 150) {
                    return { width, height: box.height, left: button.left - box.left };
                }
            }
            return null;
        });
        assert.ok(geometry, 'Fixture must wrap and put its sentence-end trigger near the left edge');
        const trigger = page.locator('.sent-analyze-btn').nth(1);
        await trigger.hover();
        const hint = page.locator('.sentence-hint.is-shown');
        const quick = page.locator('#article-sentence-quick-read');
        await quick.waitFor({ state: 'visible' });
        const anchor = await trigger.boundingBox();
        const card = await hint.boundingBox();
        const button = await quick.boundingBox();
        assert.ok(button.x >= card.x && button.x + button.width <= card.x + card.width);
        assert.ok(button.y >= card.y && button.y + button.height <= card.y + card.height);
        assert.equal(await hint.getAttribute('role'), 'dialog');
        assert.equal(await hint.evaluate((el) => getComputedStyle(el).pointerEvents), 'auto');

        // Cross the physical gap slowly, then stop over the translation before
        // moving to the button. Locator.click() alone would teleport the mouse.
        const below = await hint.getAttribute('data-placement') === 'bottom';
        placements.add(below ? 'bottom' : 'top');
        const gapY = below ? (anchor.y + anchor.height + card.y) / 2 : (card.y + card.height + anchor.y) / 2;
        await page.mouse.move(anchor.x + anchor.width / 2, gapY, { steps: 8 });
        await page.waitForTimeout(350);
        assert.ok(await hint.isVisible(), 'Popover must stay open while crossing its hover bridge');
        const text = await hint.locator('.sentence-hint-text').boundingBox();
        await page.mouse.move(text.x + 10, text.y + text.height / 2, { steps: 12 });
        await page.waitForTimeout(500);
        assert.ok(await hint.isVisible(), 'Popover must stay open while resting on its text');
        const updatedButton = await quick.boundingBox();
        await page.mouse.move(updatedButton.x + updatedButton.width / 2, updatedButton.y + updatedButton.height / 2, { steps: 20 });
        await page.waitForTimeout(350);
        assert.ok(await quick.isVisible(), 'The speaker must remain clickable after a slow mouse path');
        assert.equal((await page.locator('.paragraph-pair').boundingBox()).height, geometry.height);
        await screenshot(page, `hover-path-${width}-${locale}.png`);
        const before = await count(page);
        await page.mouse.down();
        await page.mouse.up();
        assert.equal(await count(page), before + 1);
        assert.equal(await last(page), SENTENCE);
        await finish(page);

        // Leaving the whole group dismisses it; keyboard focus can use Escape.
        await trigger.hover();
        await page.mouse.move(4, 4, { steps: 15 });
        await page.waitForTimeout(300);
        assert.equal(await page.locator('.sentence-hint.is-shown').count(), 0);
        await trigger.hover();
        await quick.focus();
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('.sentence-hint.is-shown').count(), 0);
        assert.ok(await trigger.evaluate((el) => el === document.activeElement));

        // Switching between adjacent sentences must not leave the old target.
        await page.locator('.sent-analyze-btn').first().hover();
        await trigger.hover();
        assert.equal(await page.locator('.sentence-hint-text').textContent(), TRANSLATION);

        // A short viewport can flip the popover above the sentence. Its actual
        // placement depends on the available space, and both must be clickable.
        await page.mouse.move(4, 4);
        await page.setViewportSize({ width, height: 420 });
        await trigger.scrollIntoViewIfNeeded();
        await page.waitForTimeout(500);
        await trigger.hover();
        const topCard = await hint.boundingBox();
        const topAnchor = await trigger.boundingBox();
        const edgePlacement = await hint.getAttribute('data-placement');
        placements.add(edgePlacement);
        const topButton = await quick.boundingBox();
        assert.ok(topCard.x >= 0 && topCard.x + topCard.width <= width);
        assert.ok(topCard.y >= 0 && topCard.y + topCard.height <= 420);
        assert.ok(topButton.x >= topCard.x && topButton.x + topButton.width <= topCard.x + topCard.width);
        const edgeGap = edgePlacement === 'top'
            ? (topCard.y + topCard.height + topAnchor.y) / 2
            : (topAnchor.y + topAnchor.height + topCard.y) / 2;
        await page.mouse.move(topAnchor.x + topAnchor.width / 2, edgeGap, { steps: 8 });
        await page.waitForTimeout(350);
        assert.ok(await hint.isVisible());
        await page.mouse.move(topButton.x + topButton.width / 2, topButton.y + topButton.height / 2, { steps: 16 });
        await page.waitForTimeout(350);
        assert.ok(await quick.isVisible());
        const beforeTopClick = await count(page);
        await page.mouse.down();
        await page.mouse.up();
        assert.equal(await count(page), beforeTopClick + 1);
        assert.equal(await last(page), SENTENCE);
        await finish(page);
        assert.deepEqual(errors, []);
        console.log(`PASS hover path ${width} ${locale}: wrapped tail, both bridges, text dwell, real mouse click, retargeting, viewport edges, dismissal and Escape`);
    } finally { await context.close(); }
}

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    try {
        for (const locale of ['zh-CN', 'zh-HK']) {
            for (const width of [1280, 960]) await runCase(browser, locale, width);
        }
        assert.ok(placements.has('top') && placements.has('bottom'), 'Both popover directions must be exercised');
    } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
