// 完整備份獨立放在 IndexedDB，避免與設定／後備學習資料爭用 localStorage。
// 舊備份必須寫入並讀回確認後，才移除 localStorage 中的原件。
const DB_NAME = 'bdc-backups';
const PREFIX = 'bdc:backup:v1:';
const INDEX_KEY = 'bdc:backup:index:v1';
const META_KEY = 'bdc:backup:meta:v1';
const MAX_AUTO_BACKUPS = 2;
let dbPromise = null;
let chain = Promise.resolve();

function serialize(work) {
    const result = chain.then(work, work);
    chain = result.catch(() => {});
    return result;
}

function requestValue(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('backup_read_failed'));
    });
}

function openDb() {
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(resolve => {
        let request;
        let settled = false;
        const finish = db => {
            if (settled) { if (db) db.close(); return; }
            settled = true;
            clearTimeout(timer);
            if (!db) dbPromise = null;
            resolve(db);
        };
        const timer = setTimeout(() => finish(null), 5000);
        try { request = indexedDB.open(DB_NAME, 1); }
        catch (_) { finish(null); return; }
        request.onupgradeneeded = () => {
            const db = request.result;
            for (const name of ['payloads', 'metadata']) {
                if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
            }
        };
        request.onerror = () => finish(null);
        request.onblocked = () => finish(null);
        request.onsuccess = () => {
            const db = request.result;
            db.onversionchange = () => { db.close(); dbPromise = null; };
            db.onclose = () => { dbPromise = null; };
            finish(db);
        };
    });
    return dbPromise.then(db => {
        if (!db) dbPromise = null;
        return db;
    });
}

function transaction(db, names, mode, work) {
    return new Promise((resolve, reject) => {
        let tx;
        let pending;
        try {
            tx = db.transaction(names, mode);
            pending = work(tx);
            Promise.resolve(pending).catch(() => { try { tx.abort(); } catch (_) {} });
        } catch (error) {
            try { tx?.abort(); } catch (_) {}
            reject(error);
            return;
        }
        tx.oncomplete = () => Promise.resolve(pending).then(resolve, reject);
        tx.onerror = () => reject(tx.error || new Error('backup_write_failed'));
        tx.onabort = () => reject(tx.error || new Error('backup_write_failed'));
    });
}

function metadata(raw, id) {
    const data = JSON.parse(raw);
    if (!data?.payload || typeof data.payload !== 'object') throw new Error('backup_invalid');
    return {
        id: String(id), ts: data.ts || id, note: String(data.note || ''), size: raw.length,
        manual: /(手動|手动|manual)/i.test(String(data.note || ''))
    };
}

function legacyEntries() {
    const entries = [];
    const keys = new Set();
    let oldMeta = {};
    try { oldMeta = JSON.parse(localStorage.getItem(META_KEY) || '{}') || {}; } catch (_) {}
    try {
        for (const id of JSON.parse(localStorage.getItem(INDEX_KEY) || '[]')) keys.add(PREFIX + id);
    } catch (_) {}
    // 同時救回舊版「內容寫入成功、索引寫入失敗」留下的備份。
    for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key?.startsWith(PREFIX)) keys.add(key);
    }
    for (const key of keys) {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        try {
            const entry = metadata(raw, key.slice(PREFIX.length));
            entry.manual = entry.manual || oldMeta[entry.id]?.manual === true;
            entries.push({ ...entry, raw, key });
        }
        catch (_) { /* 損壞的原件仍留在原位置，不刪除。 */ }
    }
    return entries;
}

function keptEntries(entries) {
    const sorted = entries.slice().sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    let auto = 0;
    return sorted.filter(entry => entry.manual || ++auto <= MAX_AUTO_BACKUPS);
}

async function putRaw(db, id, raw, prune = false, manual = false) {
    const entry = metadata(raw, id);
    entry.manual = entry.manual || manual;
    await transaction(db, ['payloads', 'metadata'], 'readwrite', tx => {
        const payloads = tx.objectStore('payloads');
        const metas = tx.objectStore('metadata');
        return requestValue(metas.getAll()).then(existing => {
            payloads.put({ id: entry.id, raw });
            metas.put(entry);
            if (prune) {
                const all = [entry, ...existing.filter(item => item.id !== entry.id)];
                const keep = new Set(keptEntries(all).map(item => item.id));
                for (const item of all) {
                    if (keep.has(item.id)) continue;
                    payloads.delete(item.id);
                    metas.delete(item.id);
                }
            }
        });
    });
    return entry;
}

async function readRaw(db, id) {
    return transaction(db, ['payloads'], 'readonly', tx => requestValue(tx.objectStore('payloads').get(String(id))));
}

function collisionId(id, raw) {
    let hash = 2166136261;
    for (let i = 0; i < raw.length; i += 1) hash = Math.imul(hash ^ raw.charCodeAt(i), 16777619) >>> 0;
    return `legacy_${id}_${hash.toString(16)}`;
}

function refreshLegacyIndex() {
    const entries = legacyEntries();
    try {
        if (!entries.length) {
            localStorage.removeItem(INDEX_KEY);
            localStorage.removeItem(META_KEY);
        } else {
            localStorage.setItem(INDEX_KEY, JSON.stringify(entries.map(entry => entry.id)));
            localStorage.setItem(META_KEY, JSON.stringify(Object.fromEntries(entries.map(({ raw, key, ...entry }) => [entry.id, entry]))));
        }
    } catch (_) { /* 列表也會掃描內容鍵，索引失敗不會令備份失聯。 */ }
}

async function prepare() {
    const db = await openDb();
    if (!db) return null;
    let entries;
    try { entries = legacyEntries(); } catch (_) { return db; }
    for (const entry of entries) {
        try {
            let id = entry.id;
            const existing = await readRaw(db, id);
            if (existing && existing.raw !== entry.raw) id = collisionId(id, entry.raw);
            await putRaw(db, id, entry.raw, false, entry.manual);
            const verified = await readRaw(db, id);
            if (verified?.raw !== entry.raw) continue;
            // 跨分頁若剛改寫原件，保留新原件供下一輪搬移。
            if (localStorage.getItem(entry.key) === entry.raw) localStorage.removeItem(entry.key);
        } catch (_) { /* 搬移失敗仍保留可讀取／匯出的舊備份。 */ }
    }
    refreshLegacyIndex();
    return db;
}

export function prepareBackupStorage() {
    return serialize(async () => ({ backend: await prepare() ? 'indexeddb' : 'localStorage' }));
}

export function listBackupRecords() {
    return serialize(async () => {
        const db = await prepare();
        const entries = db ? await transaction(db, ['metadata'], 'readonly', tx => requestValue(tx.objectStore('metadata').getAll())) : [];
        const found = new Map(entries.map(entry => [entry.id, entry]));
        for (const { raw, key, ...entry } of legacyEntries()) {
            if (!found.has(entry.id)) found.set(entry.id, entry);
            else if (db) {
                const existing = await readRaw(db, entry.id);
                if (existing?.raw !== raw) found.set(collisionId(entry.id, raw), { ...entry, id: collisionId(entry.id, raw), legacyId: entry.id });
            }
        }
        return Array.from(found.values()).sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    });
}

export function loadBackupRecord(id) {
    return serialize(async () => {
        const db = await prepare();
        const stored = db ? await readRaw(db, id) : null;
        if (stored?.raw) return JSON.parse(stored.raw).payload;
        const legacy = legacyEntries().find(entry => entry.id === String(id) || collisionId(entry.id, entry.raw) === String(id));
        const raw = stored?.raw || legacy?.raw;
        return raw ? JSON.parse(raw).payload : null;
    });
}

export function saveBackupRecord(payload, note = '') {
    return serialize(async () => {
        try {
            const ts = Date.now();
            const id = `${ts}-${Math.random().toString(36).slice(2, 10)}`;
            const raw = JSON.stringify({ ts, note, payload });
            const db = await prepare();
            if (db) await putRaw(db, id, raw, true);
            else {
                // 後備路徑也先確認新備份寫入，才裁剪舊自動備份。
                const before = legacyEntries();
                localStorage.setItem(PREFIX + id, raw);
                const keep = new Set(keptEntries([metadata(raw, id), ...before]).map(entry => entry.id));
                for (const entry of before) if (!keep.has(entry.id)) localStorage.removeItem(entry.key);
                refreshLegacyIndex();
            }
            return { id };
        } catch (error) { return { error }; }
    });
}

export function deleteBackupRecord(id) {
    return serialize(async () => {
        const db = await prepare();
        if (db) await transaction(db, ['payloads', 'metadata'], 'readwrite', tx => {
            tx.objectStore('payloads').delete(String(id));
            tx.objectStore('metadata').delete(String(id));
        });
        for (const entry of legacyEntries()) {
            if (entry.id === String(id) || collisionId(entry.id, entry.raw) === String(id)) localStorage.removeItem(entry.key);
        }
        refreshLegacyIndex();
    });
}
