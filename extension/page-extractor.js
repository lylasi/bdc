// Executed in the isolated world only after an explicit article action.
export function extractReadablePageInTab() {
    const candidates = [...document.querySelectorAll('article, main, [role="main"], [itemprop="articleBody"]')];
    const root = candidates.sort((a, b) => (b.innerText || '').length - (a.innerText || '').length)[0] || document.body;
    const copy = root.cloneNode(true);
    copy.querySelectorAll('script,style,noscript,nav,header,footer,aside,form,button,input,textarea,select,iframe,svg,[hidden],[aria-hidden="true"],bdc-page-lookup').forEach((el) => el.remove());
    const blocks = [...copy.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,td')];
    const text = blocks.length ? blocks.filter((el) => !el.parentElement?.closest('p,li,blockquote,pre,td')).map((el) => {
        const value = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!value) return '';
        const level = /^H[1-6]$/.test(el.tagName) ? Number(el.tagName.slice(1)) : 0;
        return (level ? '#'.repeat(level) + ' ' : el.tagName === 'LI' ? '- ' : '') + value;
    }).filter(Boolean).join('\n\n') : (copy.textContent || '').trim();
    const title = (document.querySelector('article h1, main h1, h1')?.textContent || document.title || '').trim();
    const tooLarge = Array.from(text).length > 100000;
    return { pageUrl: location.href, pageTitle: title.slice(0, 300), text: tooLarge ? '' : text, tooLarge };
}
