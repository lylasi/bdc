// 配色主題：切換主色階（primary / ring）與紙面淡色偏（paper / line），
// 語義色（ok / danger / accent / info）、文字墨色與排版維持不變。
// 使用者選擇存在 pen_global_settings.theme，屬本機偏好（與閱讀偏好一樣不進同步快照）。
import { loadGlobalSettings, saveGlobalSettings } from './settings.js';
import { applyThemeArt } from './theme-art.js';

// 排列：先沉穩色系（墨青／藍／靛／紫／石墨），再活潑與自然色系（森林綠／糖果粉／咖啡棕）。
export const THEMES = [
    { id: 'teal', labelKey: 'settings.themeTeal', swatch: '#0f766e' },
    { id: 'blue', labelKey: 'settings.themeBlue', swatch: '#1d4ed8' },
    { id: 'indigo', labelKey: 'settings.themeIndigo', swatch: '#4f46e5' },
    { id: 'violet', labelKey: 'settings.themeViolet', swatch: '#7c3aed' },
    { id: 'slate', labelKey: 'settings.themeSlate', swatch: '#475569' },
    { id: 'forest', labelKey: 'settings.themeForest', swatch: '#15803d' },
    { id: 'candy', labelKey: 'settings.themeCandy', swatch: '#db2777' },
    { id: 'coffee', labelKey: 'settings.themeCoffee', swatch: '#8a5a2b' },
    { id: 'flame', labelKey: 'settings.themeFlame', swatch: '#c2410c', icon: 'ic-flame' },
    { id: 'night', labelKey: 'settings.themeNight', swatch: '#1f2937', icon: 'ic-blade' }
];

/** 品牌標線性圖標：主題可覆寫，未指定時用預設的「紙頁」圖標 */
export const DEFAULT_BRAND_ICON = 'ic-app';

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

/** 換左上角品牌標的線性圖標；自訂圖片由 theme-art.js 負責覆蓋 */
function applyBrandIcon(themeId) {
    const iconId = THEMES.find((item) => item.id === themeId)?.icon || DEFAULT_BRAND_ICON;
    const use = document.querySelector('.brand-mark use');
    if (use) use.setAttribute('href', `#${iconId}`);
    document.documentElement.dataset.brandIcon = iconId;
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
    applyBrandIcon(theme);
    // 背景插畫與自訂品牌圖標跟著配色走；讀取是異步的，失敗不影響配色本身
    applyThemeArt(theme);
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
