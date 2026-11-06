// Conservative identity for a web page. Hash routes remain distinct.
export function pageUrlKey(value) {
    try {
        const url = new URL(String(value || '').trim());
        if (!/^https?:$/.test(url.protocol) || url.username || /^https?:\/\/[^/]*@/i.test(url.href) || url.href.length > 2048) return '';
        if (!/^#!?\//.test(url.hash)) url.hash = '';
        return url.href;
    } catch (_) { return ''; }
}

export async function pageStableId(prefix, value) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
    return prefix + '_' + [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 48);
}
