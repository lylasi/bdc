// 配色主題：只切換主色階（primary / ring），語義色（ok / danger / accent / info）維持不變。
// 使用者選擇存在 pen_global_settings.theme，屬本機偏好（與閱讀偏好一樣不進同步快照）。
import { loadGlobalSettings, saveGlobalSettings } from './settings.js';

export const THEMES = [
    { id: 'teal', labelKey: 'settings.themeTeal', swatch: '#0f766e' },
    { id: 'indigo', labelKey: 'settings.themeIndigo', swatch: '#4f46e5' },
    { id: 'violet', labelKey: 'settings.themeViolet', swatch: '#7c3aed' },
    { id: 'slate', labelKey: 'settings.themeSlate', swatch: '#475569' }
];

export const DEFAULT_THEME = 'teal';

export function isValidTheme(id) {
    return THEMES.some((theme) => theme.id === id);
}

export function getSavedTheme() {
    try {
        const saved = loadGlobalSettings()?.theme;
        return isValidTheme(saved) ? saved : DEFAULT_THEME;
    } catch (_) {
        return DEFAULT_THEME;
    }
}

/** 換 favicon 底色，讓瀏覽器分頁也跟著主題走 */
function updateFavicon(color) {
    const link = document.querySelector('link[rel="icon"]');
    if (!link || !color) return;
    const encoded = encodeURIComponent(color);
    link.href = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E"
        + `%3Crect width='24' height='24' rx='6' fill='${encoded}'/%3E`
        + "%3Cpath d='M7 6.5h6.5L17 10v7.5H7z' fill='none' stroke='white' stroke-width='1.7' stroke-linejoin='round'/%3E"
        + "%3Cpath d='M13 6.5V10h3.8' fill='none' stroke='white' stroke-width='1.7'/%3E%3C/svg%3E";
}

/** 套用主題（只改 data-theme，顏色由 styles.css 的主題區塊決定） */
export function applyTheme(id) {
    const theme = isValidTheme(id) ? id : DEFAULT_THEME;
    document.documentElement.dataset.theme = theme;
    const swatch = THEMES.find((item) => item.id === theme)?.swatch;
    if (swatch) {
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', swatch);
        updateFavicon(swatch);
    }
    return theme;
}

/** 依已儲存的偏好套用；啟動時呼叫一次 */
export function initTheme() {
    return applyTheme(getSavedTheme());
}

/** 使用者選定後：立即套用並寫回設定 */
export function saveTheme(id) {
    const theme = applyTheme(id);
    try {
        saveGlobalSettings({ theme });
    } catch (_) {
        // 寫入失敗（私密模式等）不影響本次套用
    }
    return theme;
}
