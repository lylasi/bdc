// Isolated content script. Account, AI and writes stay in the trusted frame.
(() => {
    if (globalThis.__bdcPageLookupInstalled || window.top !== window) return;
    if (document.getElementById('article-input') && document.getElementById('vocab-book-list') && document.getElementById('article-analysis-container')) return;
    globalThis.__bdcPageLookupInstalled = true;
    let host, shadow, button, panel, toast;
    let selectedRange = null, anchorRange = null, lastRect = null;
    let ticket = '', mode = 'compact', protectedState = false, desiredHeight = 180;
    let labels = {}, closeRequest = null, opening = 0, openingBusy = false, scheduled = false;
    const t = (key) => labels[key] || 'BDC';
    chrome.runtime.sendMessage({ type: 'BDC_INLINE_LABELS' }).then((result) => { labels = result?.value || {}; }).catch(() => {});

    function viewport() {
        const v = window.visualViewport;
        return { left: v?.offsetLeft || 0, top: v?.offsetTop || 0, width: v?.width || innerWidth, height: v?.height || innerHeight };
    }
    const clamp = (value, min, max) => Math.max(min, Math.min(Math.max(min, max), value));
    function rangeRect(range) {
        if (!range?.commonAncestorContainer?.isConnected) return null;
        const rect = range.getBoundingClientRect();
        return rect.height > 0 ? rect : null;
    }
    function visible(rect, v, range) {
        if (!rect) return false;
        let left = v.left, right = v.left + v.width, top = v.top, bottom = v.top + v.height;
        let element = range?.commonAncestorContainer;
        if (element?.nodeType !== 1) element = element?.parentElement;
        for (; element && element !== document.documentElement; element = element.parentElement) {
            const style = getComputedStyle(element), box = element.getBoundingClientRect();
            if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
                left = Math.max(left, box.left + element.clientLeft); right = Math.min(right, box.left + element.clientLeft + element.clientWidth);
            }
            if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
                top = Math.max(top, box.top + element.clientTop); bottom = Math.min(bottom, box.top + element.clientTop + element.clientHeight);
            }
        }
        return rect.bottom > top && rect.top < bottom && rect.right > left && rect.left < right;
    }
    function size(el, values) {
        for (const [name, value] of Object.entries(values)) {
            const css = typeof value === 'number' ? Math.round(value) + 'px' : value;
            if (el.style[name] !== css) el.style[name] = css;
        }
    }
    function removePanel() {
        opening += 1; openingBusy = false;
        panel?.remove(); panel = null; ticket = ''; closeRequest = null;
        anchorRange = null; lastRect = null; mode = 'compact'; protectedState = false;
        if (button) button.hidden = true;
    }
    function requestClose(reason, replacement = null) {
        if (!panel) { removePanel(); return; }
        if (closeRequest) return;
        if (reason !== 'replace' && reason !== 'explicit' && (mode === 'expanded' || protectedState)) return;
        const requestId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
        closeRequest = { requestId, replacement };
        chrome.runtime.sendMessage({ type: 'BDC_INLINE_REQUEST_CLOSE', ticket, requestId, reason }).then((response) => {
            if (response?.ok || closeRequest?.requestId !== requestId) return;
            closeRequest = null;
            if (reason !== 'replace' && !protectedState && mode !== 'expanded') removePanel();
        }).catch(() => { if (closeRequest?.requestId === requestId) closeRequest = null; });
    }
    function position() {
        const v = viewport();
        if (button && !button.hidden) {
            const rect = rangeRect(selectedRange);
            if (!visible(rect, v, selectedRange)) button.hidden = true;
            else {
                const box = button.getBoundingClientRect();
                const top = rect.bottom + 5 + box.height <= v.top + v.height - 8 ? rect.bottom + 5 : rect.top - box.height - 5;
                size(button, { left: clamp(rect.left, v.left + 8, v.left + v.width - box.width - 8), top: clamp(top, v.top + 8, v.top + v.height - box.height - 8) });
            }
        }
        if (!panel) return;
        if (mode === 'expanded') {
            const width = Math.min(420, Math.max(0, v.width - 24));
            size(panel, { left: v.left + v.width - width - 12, top: v.top + 12, width, height: Math.max(80, v.height - 24) });
            return;
        }
        const rect = rangeRect(anchorRange);
        if (!visible(rect, v, anchorRange) && !protectedState) { requestClose('offscreen'); return; }
        if (rect) lastRect = rect;
        if (!lastRect) return;
        const width = Math.min(340, Math.max(0, v.width - 16));
        let height = Math.min(desiredHeight, Math.max(80, v.height - 16), Math.max(160, Math.floor(v.height * 0.65)));
        const below = v.top + v.height - 8 - lastRect.bottom - 8;
        const above = lastRect.top - 8 - v.top - 8;
        const down = below >= height || below >= above;
        const space = down ? below : above;
        if (space >= 120) height = Math.min(height, space);
        const top = down ? lastRect.bottom + 8 : lastRect.top - 8 - height;
        size(panel, { left: clamp(lastRect.left, v.left + 8, v.left + v.width - width - 8),
            top: clamp(top, v.top + 8, v.top + v.height - height - 8), width, height });
    }
    function schedulePosition() {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => { scheduled = false; position(); });
    }
    async function open(range) {
        if (openingBusy || !rangeRect(range)) return;
        const version = ++opening;
        openingBusy = true; button.hidden = true; toast.hidden = true;
        const selection = getSelection();
        selection.removeAllRanges(); selection.addRange(range);
        const result = await chrome.runtime.sendMessage({ type: 'BDC_OPEN_INLINE' }).catch(() => null);
        if (version !== opening) return;
        openingBusy = false;
        if (!result?.ok) {
            toast.textContent = t('extension.inlineOpenFailed'); toast.hidden = false;
            const rect = rangeRect(range), v = viewport();
            if (rect) size(toast, { left: clamp(rect.left, v.left + 8, v.left + v.width - 300), top: clamp(rect.bottom + 8, v.top + 8, v.top + v.height - 65) });
            return;
        }
        ticket = result.value.ticket; anchorRange = range.cloneRange(); lastRect = rangeRect(anchorRange);
        mode = 'compact'; protectedState = false; desiredHeight = 180; closeRequest = null;
        panel = document.createElement('iframe');
        panel.title = t('extension.inlineTitle');
        panel.src = chrome.runtime.getURL('lookup.html') + '?embedded=1&ticket=' + encodeURIComponent(ticket);
        shadow.appendChild(panel); position();
    }
    function ensureShell() {
        if (host?.isConnected) return;
        host = document.createElement('bdc-page-lookup');
        host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
        shadow = host.attachShadow({ mode: 'closed' });
        const style = document.createElement('style');
        style.textContent = ':host{all:initial}button{font:13px system-ui;padding:7px 12px;background:#2563eb;color:#fff;border:0;border-radius:7px;box-shadow:0 2px 9px #0003;cursor:pointer;pointer-events:auto;position:fixed}iframe{box-sizing:border-box;border:1px solid #cbd5e1;border-radius:12px;background:#fff;box-shadow:0 8px 35px #0003;position:fixed;pointer-events:auto;color-scheme:light}p{position:fixed;box-sizing:border-box;max-width:300px;margin:0;padding:10px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;color:#9a3412;font:13px/1.5 system-ui;pointer-events:auto}[hidden]{display:none!important}';
        shadow.appendChild(style);
        button = document.createElement('button'); button.type = 'button'; button.textContent = t('extension.inlineLookup'); button.hidden = true;
        toast = document.createElement('p'); toast.setAttribute('role', 'status'); toast.hidden = true;
        button.addEventListener('mousedown', (event) => event.preventDefault());
        button.addEventListener('click', (event) => {
            if (!event.isTrusted || !selectedRange || openingBusy) return;
            const range = selectedRange.cloneRange();
            button.hidden = true;
            if (panel) requestClose('replace', range);
            else open(range);
        });
        shadow.append(button, toast); document.documentElement.appendChild(host);
    }
    document.addEventListener('pointerdown', (event) => {
        if (!event.isTrusted || event.composedPath().includes(host)) return;
        if (panel) requestClose('outside');
        else if (openingBusy) removePanel();
        if (toast) toast.hidden = true;
    }, true);
    document.addEventListener('mouseup', (event) => {
        if (!event.isTrusted || event.composedPath().includes(host) || event.target?.closest?.('input,textarea,[contenteditable="true"]')) return;
        const selection = getSelection(), text = selection?.toString().trim() || '';
        ensureShell();
        if (!text || text.length > 400 || !selection?.rangeCount) { button.hidden = true; return; }
        selectedRange = selection.getRangeAt(0).cloneRange();
        button.textContent = t('extension.inlineLookup'); button.hidden = false; position();
    });
    document.addEventListener('keydown', (event) => {
        if (!event.isTrusted || event.key !== 'Escape') return;
        if (panel) requestClose('explicit');
        else removePanel();
    }, true);
    chrome.runtime.onMessage.addListener((message, sender) => {
        if (sender.id !== chrome.runtime.id || !panel || message?.ticket !== ticket) return;
        if (message.type === 'BDC_INLINE_STATE') {
            mode = message.mode === 'expanded' ? 'expanded' : 'compact';
            protectedState = message.protected === true;
            if (Number.isFinite(message.height)) desiredHeight = Math.max(80, Math.min(20000, message.height));
            position();
        } else if (message.type === 'BDC_INLINE_KEEP') {
            if (closeRequest?.requestId === message.requestId) closeRequest = null;
        } else if (message.type === 'BDC_INLINE_REMOVE') {
            const replacement = closeRequest?.requestId === message.requestId ? closeRequest.replacement : null;
            removePanel();
            if (replacement) open(replacement);
        }
    });
    addEventListener('scroll', schedulePosition, { capture: true, passive: true });
    addEventListener('resize', schedulePosition);
    window.visualViewport?.addEventListener('resize', schedulePosition);
    window.visualViewport?.addEventListener('scroll', schedulePosition);
    addEventListener('popstate', removePanel);
    addEventListener('hashchange', removePanel);
})();
