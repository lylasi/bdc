export const DEFAULT_LOCALE = 'zh-CN';

export const SUPPORTED_LOCALES = {
    'zh-CN': {
        label: '大陆简体中文',
        htmlLang: 'zh-CN'
    },
    'zh-HK': {
        label: '香港繁體中文',
        htmlLang: 'zh-HK'
    }
};

export function normalizeLocale(locale) {
    return Object.prototype.hasOwnProperty.call(SUPPORTED_LOCALES, locale)
        ? locale
        : DEFAULT_LOCALE;
}
