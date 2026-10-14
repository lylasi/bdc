import { loadGlobalSettings, saveGlobalSettings } from './settings.js';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, normalizeLocale } from './i18n-config.js';
import zhCN from '../locales/zh-CN.js';
import zhHK from '../locales/zh-HK.js';

const dictionaries = {
    'zh-CN': zhCN,
    'zh-HK': zhHK
};

let currentLocale = normalizeLocale(loadGlobalSettings()?.language?.interfaceLocale || DEFAULT_LOCALE);

function getByPath(source, key) {
    return String(key || '').split('.').reduce((value, part) => value?.[part], source);
}

function interpolate(value, params = {}) {
    return String(value).replace(/\{(\w+)\}/g, (match, key) => (
        Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match
    ));
}

export function getLocale() {
    return currentLocale;
}

/**
 * 目前介面語言對應的 BCP-47 標籤（zh-CN / zh-HK），給 Intl 與 toLocaleString 用。
 * 先前有幾處直接寫死 'zh-TW' 或省略參數（變成瀏覽器語言），
 * 結果切到簡體時日期仍是繁體格式、或跟著系統語言跑。
 */
export function getLocaleTag() {
    return SUPPORTED_LOCALES[currentLocale]?.htmlLang || currentLocale;
}

/** 依介面語言格式化日期時間；options 省略時用「在地化日期＋時間」 */
export function formatDateTime(value, options) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return options ? date.toLocaleString(getLocaleTag(), options) : date.toLocaleString(getLocaleTag());
}

/** 依介面語言建立排序器（中文排序在簡繁下的結果不同） */
export function createCollator(options = { sensitivity: 'base' }) {
    return new Intl.Collator(getLocaleTag(), options);
}

export function t(key, params = {}) {
    const localized = getByPath(dictionaries[currentLocale], key);
    const fallback = getByPath(dictionaries[DEFAULT_LOCALE], key);
    const value = localized ?? fallback;
    if (value === undefined) {
        console.warn(`i18n: missing translation key "${key}" for ${currentLocale}`);
        return key;
    }
    return interpolate(value, params);
}

export function applyTranslations(root = document) {
    if (!root?.querySelectorAll) return;
    root.querySelectorAll('[data-i18n]').forEach((element) => {
        element.textContent = t(element.dataset.i18n);
    });
    root.querySelectorAll('[data-i18n-title]').forEach((element) => {
        element.setAttribute('title', t(element.dataset.i18nTitle));
    });
    root.querySelectorAll('[data-i18n-aria-label]').forEach((element) => {
        element.setAttribute('aria-label', t(element.dataset.i18nAriaLabel));
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach((element) => {
        element.setAttribute('placeholder', t(element.dataset.i18nPlaceholder));
    });
    root.querySelectorAll('[data-i18n-value]').forEach((element) => {
        element.value = t(element.dataset.i18nValue);
    });
}

export function setLocale(locale, { persist = true } = {}) {
    const nextLocale = normalizeLocale(locale);
    currentLocale = nextLocale;
    document.documentElement.lang = SUPPORTED_LOCALES[nextLocale].htmlLang;
    if (persist) saveGlobalSettings({ language: { interfaceLocale: nextLocale } });
    applyTranslations(document);
    document.dispatchEvent(new CustomEvent('bdc:locale-change', {
        detail: { locale: nextLocale }
    }));
    return nextLocale;
}

export function initI18n() {
    return setLocale(loadGlobalSettings()?.language?.interfaceLocale || DEFAULT_LOCALE, { persist: false });
}
