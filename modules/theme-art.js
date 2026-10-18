// 每套配色可各掛一張本機背景插畫（例如自己喜歡的角色圖）。
// 圖片只存在瀏覽器 IndexedDB（bdc-theme-art）：不進 localStorage、不進同步快照、
// 不會被寫進倉庫或部署包；清掉站點資料即消失。
// 顯示參數（啟用／濃度／模糊）屬於介面偏好，走 pen_global_settings.themeArt。
import { loadGlobalSettings, saveGlobalSettings } from './settings.js';

const DB_NAME = 'bdc-theme-art';
const DB_VERSION = 2;    // v2 新增 icons（自訂品牌圖標）
const STORE = 'arts';
const ICON_STORE = 'icons';
const MAX_EDGE = 1920;   // 背景插畫長邊上限，超出等比縮小，避免行動端吃記憶體
const MAX_ICON_EDGE = 256;
const SETTINGS_KEY = 'themeArt';
const STRENGTH_RANGE = [0, 0.5];
const BLUR_RANGE = [0, 8];
const MAX_BYTES = 20 * 1024 * 1024;

export const ART_DEFAULTS = Object.freeze({ enabled: true, strength: 0.22, blur: 2 });

// 隨專案打包的主題預設插畫／圖標；使用者在設定裡自選的圖片會覆蓋它。
// 只在自用場景放入角色素材，公開部署前請自行確認素材授權。
const THEME_DEFAULTS = Object.freeze({
    flame: { art: 'assets/theme/flame-bg.webp', icon: 'assets/theme/flame-icon.webp' }
});

/** 目前配色是否有內建預設插畫；回傳相對路徑或空字串 */
export function getThemeDefaultArt(themeId) {
    return (THEME_DEFAULTS[themeId] && THEME_DEFAULTS[themeId].art) || '';
}

let dbPromise = null;
let currentObjectUrl = null;
let currentIconUrl = null;
let currentThemeHasArt = false;
// 主題切換很快時，後到的 IndexedDB 讀取可能蓋掉較新的結果，用序號丟棄過期回應
let applyToken = 0;

function clampNumber(value, [min, max], fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function openArtDB() {
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
        try {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    db.createObjectStore(STORE, { keyPath: 'themeId' });
                }
                if (!db.objectStoreNames.contains(ICON_STORE)) {
                    db.createObjectStore(ICON_STORE, { keyPath: 'themeId' });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
            req.onblocked = () => resolve(null);
        } catch (_) {
            resolve(null);
        }
    });
    return dbPromise;
}

async function withStore(storeName, mode, run) {
    const db = await openArtDB();
    if (!db) return null;
    return new Promise((resolve) => {
        try {
            const tx = db.transaction(storeName, mode);
            const store = tx.objectStore(storeName);
            const req = run(store);
            req.onsuccess = () => resolve(req.result === undefined ? null : req.result);
            req.onerror = () => resolve(null);
        } catch (_) {
            resolve(null);
        }
    });
}

async function readRecord(themeId) {
    if (!themeId) return null;
    const record = await withStore(STORE, 'readonly', (store) => store.get(themeId));
    return record && record.blob ? record : null;
}

async function writeRecord(record) {
    const ok = await withStore(STORE, 'readwrite', (store) => store.put(record));
    return ok !== null;
}

async function deleteRecord(themeId) {
    if (!themeId) return false;
    await withStore(STORE, 'readwrite', (store) => store.delete(themeId));
    return true;
}

async function readIconRecord(themeId) {
    if (!themeId) return null;
    const record = await withStore(ICON_STORE, 'readonly', (store) => store.get(themeId)).catch(() => null);
    return record && record.blob ? record : null;
}

async function writeIconRecord(record) {
    const ok = await withStore(ICON_STORE, 'readwrite', (store) => store.put(record));
    return ok !== null;
}

async function deleteIconRecord(themeId) {
    if (!themeId) return false;
    await withStore(ICON_STORE, 'readwrite', (store) => store.delete(themeId));
    return true;
}

/** 縮到長邊上限內並轉 WebP；任何一步失敗就退回原始檔，保證功能可用 */
async function normalizeImage(file, maxEdge = MAX_EDGE) {
    const fallback = { blob: file, width: 0, height: 0 };
    if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return fallback;
    let bitmap = null;
    try {
        bitmap = await createImageBitmap(file);
        const longest = Math.max(bitmap.width, bitmap.height) || 1;
        const scale = Math.min(1, maxEdge / longest);
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return fallback;
        ctx.drawImage(bitmap, 0, 0, width, height);
        const blob = await new Promise((resolve) => {
            try {
                canvas.toBlob((result) => resolve(result), 'image/webp', 0.82);
            } catch (_) {
                resolve(null);
            }
        });
        return blob ? { blob, width, height } : fallback;
    } catch (_) {
        return fallback;
    } finally {
        if (bitmap && typeof bitmap.close === 'function') bitmap.close();
    }
}

export function getArtSettings() {
    let saved = null;
    try {
        saved = loadGlobalSettings()?.[SETTINGS_KEY] || null;
    } catch (_) {
        saved = null;
    }
    const source = saved && typeof saved === 'object' ? saved : {};
    return {
        enabled: source.enabled !== false,
        strength: clampNumber(source.strength, STRENGTH_RANGE, ART_DEFAULTS.strength),
        blur: clampNumber(source.blur, BLUR_RANGE, ART_DEFAULTS.blur)
    };
}

export function saveArtSettings(patch = {}) {
    const merged = { ...getArtSettings(), ...(patch || {}) };
    const next = {
        enabled: merged.enabled !== false,
        strength: clampNumber(merged.strength, STRENGTH_RANGE, ART_DEFAULTS.strength),
        blur: clampNumber(merged.blur, BLUR_RANGE, ART_DEFAULTS.blur)
    };
    try {
        saveGlobalSettings({ [SETTINGS_KEY]: next });
    } catch (_) {
        // 私密模式等寫入失敗不影響本次預覽
    }
    return next;
}

/** 把顯示參數寫進 CSS 變量；插畫是否存在由 applyThemeArt 決定 */
export function applyArtSettings(settings = getArtSettings()) {
    const root = document.documentElement;
    const scrim = Math.round((1 - settings.strength) * 100) / 100;
    root.style.setProperty('--art-scrim', String(scrim));
    root.style.setProperty('--art-blur', `${settings.blur}px`);
    root.dataset.themeArt = settings.enabled && currentThemeHasArt ? 'on' : 'off';
    return settings;
}

/** 把品牌圖標畫到左上角；url 為空時回到主題內建的線性圖標 */
function applyIconUrl(url) {
    const img = document.querySelector('.brand-mark-img');
    const mark = document.querySelector('.brand-mark');
    if (!img || !mark) return;
    if (!url) {
        img.hidden = true;
        img.removeAttribute('src');
        mark.classList.remove('has-custom-icon');
        return;
    }
    img.src = url;
    img.hidden = false;
    mark.classList.add('has-custom-icon');
}

/** 釋放上一次的 objectURL（使用者自選圖才有） */
function releaseIconUrl() {
    if (!currentIconUrl) return;
    try {
        URL.revokeObjectURL(currentIconUrl);
    } catch (_) {
        // 忽略
    }
    currentIconUrl = null;
}

/** 依目前配色掛上／卸下插畫層；找不到圖片時自動關閉 */
export async function applyThemeArt(themeId) {
    const root = document.documentElement;
    const token = ++applyToken;
    const defaults = THEME_DEFAULTS[themeId] || {};
    const [record, iconRecord] = await Promise.all([
        readRecord(themeId).catch(() => null),
        readIconRecord(themeId).catch(() => null)
    ]);
    if (token !== applyToken) return false; // 已被更晚的主題切換取代

    // 圖標優先序：使用者自選 → 主題內建圖標圖 → 主題線性圖標
    releaseIconUrl();
    if (iconRecord) {
        currentIconUrl = URL.createObjectURL(iconRecord.blob);
        applyIconUrl(currentIconUrl);
    } else {
        applyIconUrl(defaults.icon || '');
    }

    // 背景優先序：使用者自選 → 主題內建插畫 → 無
    if (currentObjectUrl) {
        try {
            URL.revokeObjectURL(currentObjectUrl);
        } catch (_) {
            // 忽略
        }
        currentObjectUrl = null;
    }
    root.style.removeProperty('--theme-art');
    const artUrl = record ? URL.createObjectURL(record.blob) : (defaults.art || '');
    if (record) currentObjectUrl = artUrl;
    currentThemeHasArt = !!artUrl;
    if (!currentThemeHasArt) {
        root.dataset.themeArt = 'off';
        return false;
    }
    root.style.setProperty('--theme-art', `url("${artUrl}")`);
    applyArtSettings();
    return true;
}

export async function getThemeArtMeta(themeId) {
    const record = await readRecord(themeId).catch(() => null);
    if (!record) return null;
    return {
        themeId: record.themeId,
        name: record.name || '',
        width: record.width || 0,
        height: record.height || 0,
        size: record.blob?.size || 0,
        updatedAt: record.updatedAt || 0
    };
}

/** 讀入使用者選的圖片 → 縮圖 → 存進 IndexedDB（只留在本機） */
export async function setThemeArtFromFile(themeId, file) {
    if (!themeId) throw new Error('missing-theme');
    if (!file) throw new Error('missing-file');
    if (!/^image\//.test(file.type || '')) throw new Error('unsupported-type');
    if (file.size > MAX_BYTES) throw new Error('too-large');
    const { blob, width, height } = await normalizeImage(file);
    if (!blob) throw new Error('read-failed');
    const ok = await writeRecord({
        themeId,
        blob,
        name: file.name || 'image',
        type: blob.type || file.type || '',
        width,
        height,
        updatedAt: Date.now()
    });
    if (!ok) throw new Error('storage-failed');
    return { name: file.name || 'image', width, height, size: blob.size };
}

export async function removeThemeArt(themeId) {
    await deleteRecord(themeId);
    return applyThemeArt(themeId);
}

export async function hasThemeArt(themeId) {
    return !!(await readRecord(themeId).catch(() => null));
}

export async function getThemeIconMeta(themeId) {
    const record = await readIconRecord(themeId).catch(() => null);
    if (!record) return null;
    return {
        themeId: record.themeId,
        name: record.name || '',
        width: record.width || 0,
        height: record.height || 0,
        size: record.blob?.size || 0,
        updatedAt: record.updatedAt || 0
    };
}

/** 自訂品牌圖標：同樣只留在本機，縮到長邊 256 以免拖慢首屏 */
export async function setThemeIconFromFile(themeId, file) {
    if (!themeId) throw new Error('missing-theme');
    if (!file) throw new Error('missing-file');
    if (!/^image\//.test(file.type || '')) throw new Error('unsupported-type');
    if (file.size > MAX_BYTES) throw new Error('too-large');
    const { blob, width, height } = await normalizeImage(file, MAX_ICON_EDGE);
    if (!blob) throw new Error('read-failed');
    const ok = await writeIconRecord({
        themeId,
        blob,
        name: file.name || 'icon',
        type: blob.type || file.type || '',
        width,
        height,
        updatedAt: Date.now()
    });
    if (!ok) throw new Error('storage-failed');
    return { name: file.name || 'icon', width, height, size: blob.size };
}

export async function removeThemeIcon(themeId) {
    await deleteIconRecord(themeId);
    return applyThemeArt(themeId);
}
