// Executed in the isolated world only after an explicit article action.
export function extractReadablePageInTab() {
    const copy = document.body.cloneNode(true);
    copy.querySelectorAll('script,style,noscript,nav,header,footer,aside,form,button,input,textarea,select,iframe,svg,[hidden],[aria-hidden="true"],bdc-page-lookup,[role="complementary"],.sidebar,.main-aside,.related-articles,.related-posts,.related-news').forEach((el) => el.remove());
    const proseSelector = 'p,li,blockquote,pre,td';
    const headingSelector = 'h1,h2,h3,h4,h5,h6';
    const blockSelector = headingSelector + ',' + proseSelector;
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const textLength = (node) => normalize(node.textContent).length;
    const linkLength = (node) => [...node.querySelectorAll('a')].reduce((sum, link) => sum + textLength(link), 0);
    const outerBlocks = (node, selector) => (node.matches(selector) ? [node] : [...node.querySelectorAll(selector)])
        .filter((el) => {
            const parent = el.parentElement?.closest(proseSelector);
            return !parent || !node.contains(parent);
        });
    // Newsrooms often use div.article-body for the story and <article> for
    // related links. Judge cleaned prose, rather than the tag or raw length.
    const candidates = new Set(copy.querySelectorAll('article,main,[role="main"],[itemprop~="articleBody"],.article,.article-body,.article-content,.entry-content,.post-content,.story-body,.story-content,#article,#content'));
    const heading = copy.querySelector('h1');
    for (let parent = heading?.parentElement; parent && parent !== copy; parent = parent.parentElement) candidates.add(parent);
    const score = (node) => {
        const length = textLength(node);
        if (!length) return 0;
        const linked = linkLength(node);
        const prose = outerBlocks(node, proseSelector).reduce((sum, block) => sum + Math.max(0, textLength(block) - linkLength(block)), 0);
        const titleBonus = prose && heading && node.contains(heading) ? Math.min(160, prose * 0.1) : 0;
        const headings = [...node.querySelectorAll(headingSelector)].reduce((sum, el) => sum + Math.max(0, textLength(el) - linkLength(el)), 0);
        // Support plain-text bodies, without treating a heading or a linked
        // teaser and its date as article prose.
        const content = prose || (linked < length / 2 ? Math.max(0, length - linked - headings) : 0);
        return content * Math.max(0, 1 - linked / length) + titleBonus;
    };
    let root = copy;
    let bestScore = 0;
    for (const candidate of candidates) {
        const candidateScore = score(candidate);
        if (candidateScore > bestScore || (candidateScore > 0 && candidateScore === bestScore && root.contains(candidate))) {
            root = candidate;
            bestScore = candidateScore;
        }
    }
    const blocks = outerBlocks(root, blockSelector);
    const text = blocks.length ? blocks.map((el) => {
        const value = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!value) return '';
        const level = /^H[1-6]$/.test(el.tagName) ? Number(el.tagName.slice(1)) : 0;
        return (level ? '#'.repeat(level) + ' ' : el.tagName === 'LI' ? '- ' : '') + value;
    }).filter(Boolean).join('\n\n') : (root.textContent || '').trim();
    const title = (document.querySelector('article h1, main h1, h1')?.textContent || document.title || '').trim();
    const tooLarge = Array.from(text).length > 100000;
    return { pageUrl: location.href, pageTitle: title.slice(0, 300), text: tooLarge ? '' : text, tooLarge };
}
