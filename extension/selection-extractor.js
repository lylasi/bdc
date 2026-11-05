// The injected function is self-contained; the pure wrapper exercises the same
// sentence boundary and offset logic without copying a second implementation.
export function extractSentenceAndContextFromText(fullText, selectedText, selectionStartIndex = -1) {
    const { text, sentence, context } = extractActivePageSelectionInTab(fullText, selectedText, selectionStartIndex);
    return { text, sentence, context };
}

export function extractActivePageSelectionInTab(fullText = null, selectedText = '', selectionStartIndex = -1) {
    try {
        let block = fullText;
        let selected = String(selectedText || '');
        let offset = selectionStartIndex;
        const fromPage = block === null;
        if (fromPage) {
            const selection = window.getSelection();
            selected = selection ? selection.toString() : '';
            const input = document.activeElement;
            if (!selected && input && (input.tagName === 'TEXTAREA'
                || (input.tagName === 'INPUT' && /^(text|search|url|email|tel)$/i.test(input.type)))) {
                offset = input.selectionStart || 0;
                selected = input.value.slice(offset, input.selectionEnd || offset);
                block = input.value;
            } else if (selected && selection.rangeCount) {
                const range = selection.getRangeAt(0);
                let container = range.commonAncestorContainer;
                if (container.nodeType === 3) container = container.parentElement;
                while (container.parentElement && container !== document.body
                    && !/^(P|ARTICLE|SECTION|MAIN|LI|BLOCKQUOTE|DIV|TD)$/i.test(container.tagName)) {
                    container = container.parentElement;
                }
                // Use the same text representation for the prefix and contents.
                // This keeps offsets correct through nested spans and whitespace.
                const prefix = document.createRange();
                prefix.selectNodeContents(container);
                prefix.setEnd(range.startContainer, range.startOffset);
                offset = prefix.toString().length;
                const contents = document.createRange();
                contents.selectNodeContents(container);
                block = contents.toString();
            }
        }

        block = String(block || '');
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const text = normalize(selected);
        const page = fromPage ? { pageUrl: location.href, pageTitle: document.title } : {};
        if (!text) return { ok: true, empty: true, text: '', sentence: '', context: '', ...page };
        if (!block) return { ok: true, empty: false, text, sentence: text, context: '', ...page };
        if (!Number.isInteger(offset) || offset < 0) offset = block.indexOf(selected);
        offset = Math.max(0, offset) + (selected.match(/^\s*/)?.[0].length || 0);

        const segments = typeof Intl.Segmenter === 'function'
            ? Array.from(new Intl.Segmenter('en', { granularity: 'sentence' }).segment(block), (item) => ({
                index: item.index, segment: item.segment
            }))
            : Array.from(block.matchAll(/[^.!?。！？]+[.!?。！？]*/g), (match) => ({
                index: match.index, segment: match[0]
            }));
        const index = Math.max(0, segments.findIndex((item) => offset < item.index + item.segment.length));
        const sentence = normalize(segments[index]?.segment || block);
        const nearby = segments.slice(Math.max(0, index - 1), index + 2);
        const contextStart = nearby[0]?.index || 0;
        const contextEnd = nearby.at(-1) ? nearby.at(-1).index + nearby.at(-1).segment.length : block.length;
        const clipStart = Math.max(contextStart, offset - 700);
        const context = normalize(block.slice(clipStart, Math.min(contextEnd, clipStart + 1600)));
        return { ok: true, empty: false, text, sentence, context, ...page };
    } catch (_) {
        return { ok: false, restricted: true, text: '', sentence: '', context: '' };
    }
}
