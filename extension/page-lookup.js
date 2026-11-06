// Isolated content script: only page selection and the floating shell live here.
// Account, AI credentials and writes remain inside the extension-origin frame.
(() => {
    if (globalThis.__bdcPageLookupInstalled || window.top !== window) return;
    if (document.getElementById('article-input') && document.getElementById('vocab-book-list') && document.getElementById('article-analysis-container')) return;
    globalThis.__bdcPageLookupInstalled = true;
    let host, shadow, button, panel, ticket = '', selection = '', labels = {};
    const t = (key) => labels[key] || 'BDC';
    chrome.runtime.sendMessage({ type: 'BDC_INLINE_LABELS' }).then((result) => { labels = result?.value || {}; }).catch(() => {});
    function ensureShell() {
        if (host?.isConnected) return;
        host = document.createElement('bdc-page-lookup');
        host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
        shadow = host.attachShadow({ mode: 'closed' });
        const style = document.createElement('style');
        style.textContent = ':host{all:initial}button{font:13px system-ui;padding:7px 12px;background:#2563eb;color:white;border:0;border-radius:7px;box-shadow:0 2px 9px #0003;cursor:pointer;pointer-events:auto;position:fixed}iframe{border:1px solid #cbd5e1;border-radius:12px;background:#f8fafc;box-shadow:0 8px 35px #0004;position:fixed;right:12px;top:12px;width:min(420px,calc(100vw - 24px));height:calc(100vh - 24px);pointer-events:auto;color-scheme:light}';
        shadow.appendChild(style);
        button = document.createElement('button');
        button.type = 'button'; button.textContent = t('extension.inlineLookup'); button.hidden = true;
        button.addEventListener('mousedown', (event) => event.preventDefault());
        button.addEventListener('click', async (event) => {
            if (!event.isTrusted) return;
            button.hidden = true;
            const result = await chrome.runtime.sendMessage({ type: 'BDC_OPEN_INLINE' }).catch(() => null);
            if (!result?.ok) return;
            ticket = result.value.ticket;
            panel?.remove();
            panel = document.createElement('iframe');
            panel.title = t('extension.inlineTitle');
            panel.src = chrome.runtime.getURL('lookup.html') + '?embedded=1&ticket=' + encodeURIComponent(ticket);
            shadow.appendChild(panel);
        });
        shadow.appendChild(button);
        document.documentElement.appendChild(host);
    }
    document.addEventListener('mouseup', (event) => {
        if (!event.isTrusted || event.composedPath().includes(host) || event.target?.closest?.('input,textarea,[contenteditable="true"]')) return;
        const selected = getSelection();
        selection = selected?.toString().trim() || '';
        ensureShell();
        if (!selection || selection.length > 400 || !selected?.rangeCount) { button.hidden = true; return; }
        const rect = selected.getRangeAt(0).getBoundingClientRect();
        button.textContent = t('extension.inlineLookup');
        button.style.left = Math.max(8, Math.min(innerWidth - 100, rect.left)) + 'px';
        button.style.top = Math.max(8, Math.min(innerHeight - 48, rect.bottom + 5)) + 'px';
        button.hidden = false;
    });
    function close() { panel?.remove(); panel = null; if (button) button.hidden = true; ticket = ''; }
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
    addEventListener('message', (event) => {
        if (panel && event.source === panel.contentWindow && event.data?.type === 'BDC_CLOSE_INLINE' && event.data.ticket === ticket) close();
    });
    addEventListener('popstate', close);
    addEventListener('hashchange', close);
})();
