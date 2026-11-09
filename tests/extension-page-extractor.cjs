// Browser regression for chrome.scripting's self-contained page extractor.
// No AI response is involved: these checks verify exactly what reaches cleanup.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const title = 'Statement from NVIDIA Board of Directors';
const paragraphs = Array.from({ length: 6 }, (_, index) => `Board statement paragraph ${index + 1}. This belongs to the current press release.`);
const relatedTitle = 'NVIDIA and Oracle Expand NVIDIA Vera Rubin to Multi-Gigawatt Scale and Bring NVIDIA Vera CPU to Oracle Cloud Infrastructure';
// Minimal reproduction of the source's div.article / div.article-body and
// article.index-item markup. Paragraphs are synthetic to keep this fixture stable.
const newsroom = `<!doctype html><title>${title} | NVIDIA Newsroom</title>
    <header><nav>Navigation noise</nav></header>
    <div class="main row"><div class="main-content"><div class="article">
        <h1>${title}</h1><div class="article-date">November 8, 2026</div>
        <figure><img alt="NVIDIA logo"></figure>
        <div class="article-body">${paragraphs.map((text) => `<p>${text}</p>`).join('')}<p><br><img alt=""></p></div>
    </div></div><div class="main-aside"><h2>More News</h2>
        <article class="index-item"><h3><a href="/news/another">A Message to Our Company</a></h3></article>
        <article class="index-item"><h3><a href="/news/oracle">${relatedTitle}</a></h3><div>October 27, 2026</div></article>
    </div></div><footer>Footer noise</footer>`;

(async () => {
    const { extractReadablePageInTab } = await import('../extension/page-extractor.js');
    const browser = await chromium.launch({ headless: true });
    let checks = 0;
    try {
        const page = await browser.newPage();
        const sourceUrl = 'https://nvidianews.nvidia.com/news/statement-from-nvidia-board-of-directors';
        await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: newsroom }));
        await page.goto(sourceUrl);
        const original = await page.content();
        const result = await page.evaluate(extractReadablePageInTab);
        assert.deepEqual(result, { pageUrl: sourceUrl, pageTitle: title, text: '# ' + title + '\n\n' + paragraphs.join('\n\n'), tooLarge: false });
        assert.equal(await page.content(), original, 'extraction must leave the source DOM intact');
        console.log('PASS newsroom: all six paragraphs, correct title/URL, no related news, unchanged DOM');
        checks += 1;

        const cases = [
            {
                name: 'standard article remains scoped despite unrelated body paragraphs',
                html: '<title>Story</title><article><h1>Story</h1><p>Current story.</p></article><div><p>Cookie notice outside the article.</p></div>',
                text: '# Story\n\nCurrent story.'
            },
            {
                name: 'prose wins over longer linked article cards inside main',
                html: '<main><div class="entry-content"><h1>Story</h1><p>Current story.</p></div><section><article><h3><a href="/other">' + relatedTitle.repeat(8) + '</a></h3></article></section></main>',
                text: '# Story\n\nCurrent story.'
            },
            {
                name: 'schema articleBody supports multiple itemprop tokens and very short text',
                html: '<title>Short story</title><div itemprop="text articleBody"><p>Short statement.</p></div><article><h3><a href="/other">' + relatedTitle + '</a></h3></article>',
                text: 'Short statement.'
            },
            {
                name: 'unmarked story found through the main heading ancestors',
                html: '<div><div><h1>Story</h1></div><p>First paragraph.</p><p>Last paragraph.</p></div><article><h3><a href="/other">' + relatedTitle + '</a></h3></article>',
                text: '# Story\n\nFirst paragraph.\n\nLast paragraph.'
            },
            {
                name: 'linked headline candidates fall back to unmarked body prose',
                html: '<title>Story</title><div><p>Current story.</p></div><article><h3><a href="/other">' + relatedTitle + '</a></h3></article>',
                includes: 'Current story.'
            },
            {
                name: 'plain text without paragraph markup remains readable',
                html: '<title>Plain story</title><nav>Noise</nav><main>Plain article body without paragraph tags.</main>',
                text: 'Plain article body without paragraph tags.'
            },
            {
                name: 'plain text in main is not replaced by an unrelated paragraph',
                html: '<title>Plain story</title><main>Plain article body without paragraph tags.</main><div><p>Cookie notice.</p></div>',
                text: 'Plain article body without paragraph tags.'
            },
            {
                name: 'a title-only wrapper cannot beat a very short story',
                html: '<div><div><h1>A long heading above a very short story</h1></div><p>OK.</p></div>',
                text: '# A long heading above a very short story\n\nOK.'
            },
            {
                name: 'private controls, hidden text, sidebars and extension UI are excluded',
                html: '<article><h1>Story</h1><p>Current story.</p><p hidden>Hidden secret</p><div aria-hidden="true"><p>Aria secret</p></div><form><p>Private form</p><input value="private-value"><textarea>Private draft</textarea></form><div role="complementary"><p>Sidebar secret</p></div><bdc-page-lookup><p>Extension secret</p></bdc-page-lookup><script>window.secret = "Script secret"</script></article>',
                text: '# Story\n\nCurrent story.'
            },
            {
                name: 'headings, lists and nested prose are kept once',
                html: '<article><h1>Story</h1><p>First <strong>paragraph</strong>.</p><h2>Details</h2><ul><li><p>One item.</p></li></ul><blockquote><p>One quotation.</p></blockquote></article>',
                text: '# Story\n\nFirst paragraph.\n\n## Details\n\n- One item.\n\nOne quotation.'
            },
            {
                name: 'empty pages return empty content',
                html: '<title>Empty</title><main></main><form><textarea>Private</textarea></form>',
                text: ''
            },
            {
                name: '100000 code points remain allowed',
                html: '<title>Boundary</title><article><p>' + '😀'.repeat(100000) + '</p></article>',
                text: '😀'.repeat(100000)
            },
            {
                name: 'oversized content is blocked rather than silently truncated',
                html: '<title>Oversized</title><div class="article-body"><p>' + 'a'.repeat(100001) + '</p></div><article><h3><a href="/other">Short related headline</a></h3></article>',
                text: '', tooLarge: true
            }
        ];
        for (const item of cases) {
            await page.setContent(item.html);
            const extracted = await page.evaluate(extractReadablePageInTab);
            if (item.includes) assert.ok(extracted.text.includes(item.includes), item.name);
            else assert.equal(extracted.text, item.text, item.name);
            assert.equal(extracted.tooLarge, !!item.tooLarge, item.name);
            console.log('PASS ' + item.name);
            checks += 1;
        }
        console.log(`${checks}/${checks} extraction checks passed`);
    } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
