// 測試用 IndexedDB 替身：只實作 permanent-db／article-store 實際使用的 API，
// 但交易語意必須可靠：
//   * 同一交易內看得到自己的寫入，其他交易看不到未提交的寫入；
//   * 交易 abort（同步例外、非同步失敗、明確 abort）會丟棄全部寫入；
//   * 重疊 store 的 readwrite 交易照建立順序序列化，不會互相覆蓋。
//
// 沒有這層語意，「交易中止要整批回滾」的測試會誤判成功（舊版直接把
// put 寫進共用 Map，abort 後仍讀得到資料）。
//
// 只支援本專案用到的部分：open／upgrade、transaction、get/put/delete/
// getAll/count、index.getAll/count；沒有游標與複合鍵路徑的完整實作。

function clone(value) {
    if (value === undefined) return undefined;
    return structuredClone(value);
}

function valueAtKeyPath(value, keyPath) {
    if (Array.isArray(keyPath)) return keyPath.map((part) => valueAtKeyPath(value, part));
    return String(keyPath || '').split('.').reduce((current, part) => (
        current && typeof current === 'object' ? current[part] : undefined
    ), value);
}

function sameKey(left, right) {
    if (Array.isArray(left) || Array.isArray(right)) {
        const a = Array.isArray(left) ? left : [left];
        const b = Array.isArray(right) ? right : [right];
        return a.length === b.length && a.every((item, index) => String(item) === String(b[index]));
    }
    return String(left) === String(right);
}

function abortError(name = 'AbortError') {
    const error = new Error(name);
    error.name = name;
    return error;
}

class FakeRequest {
    constructor() {
        this.result = undefined;
        this.error = null;
        this.onsuccess = null;
        this.onerror = null;
    }
}

class FakeTransaction {
    constructor(db, names, mode) {
        this.db = db;
        this.mode = mode;
        this.names = Array.from(new Set(names));
        this.oncomplete = null;
        this.onerror = null;
        this.onabort = null;
        this._state = 'pending';
        this._aborted = false;
        this._abortFromError = false;
        this._ops = [];
        this._pending = 0;
        this._stores = new Map();
        this._snapshot = new Map();
        this._scheduled = false;
        this._completeScheduled = false;
        this.db._queue.push(this);
        this.db._pump();
    }

    objectStore(name) {
        if (this.mode !== 'versionchange' && !this.names.includes(name)) {
            throw new Error('NotFoundError: ' + name);
        }
        const data = this.db._stores.get(name);
        if (!data) throw new Error('NotFoundError: ' + name);
        if (!this._stores.has(name)) this._stores.set(name, new FakeObjectStore(this, data, name));
        return this._stores.get(name);
    }

    _overlaps(other) {
        if (this.mode === 'versionchange' || other.mode === 'versionchange') return true;
        return this.names.some((name) => other.names.includes(name));
    }

    /** 由 db._pump() 呼叫：建立交易當下的已提交快照。 */
    _start() {
        if (this._state !== 'pending') return;
        this._state = 'running';
        for (const name of this.names) {
            const live = this.db._stores.get(name);
            if (!live) continue;
            // versionchange 直接操作正式資料；一般交易先寫在自己的快照，
            // 提交時才整批換回，abort 就整個丟棄。
            this._snapshot.set(name, this.mode === 'versionchange'
                ? live.data
                : new Map(Array.from(live.data, ([key, value]) => [key, clone(value)])));
        }
        this._schedule();
    }

    _dataFor(name) {
        if (!this._snapshot.has(name)) this._snapshot.set(name, new Map());
        return this._snapshot.get(name);
    }

    _enqueue(apply) {
        if (this._aborted || this._state === 'finished') throw abortError('TransactionInactiveError');
        const request = new FakeRequest();
        this._pending += 1;
        this._ops.push({ request, apply });
        this._schedule();
        return request;
    }

    _schedule() {
        if (this._state !== 'running' || this._scheduled) return;
        this._scheduled = true;
        setTimeout(() => {
            this._scheduled = false;
            this._drain();
        }, 0);
    }

    _drain() {
        if (this._state !== 'running') return;
        while (this._ops.length) {
            const { request, apply } = this._ops.shift();
            this._pending -= 1;
            if (this._aborted) {
                request.error = abortError();
                request.onerror?.({ target: request });
                continue;
            }
            try {
                request.result = apply();
                request.onsuccess?.({ target: request });
            } catch (error) {
                request.error = error;
                request.onerror?.({ target: request });
                this._abortNow(true);
                continue;
            }
            // 與真實 IndexedDB 一樣，讓 onsuccess 內的 microtask 有機會
            // 繼續排入 request，才決定交易是否完成。
            if (this._ops.length) break;
        }
        if (this._ops.length) {
            this._schedule();
            return;
        }
        this._maybeFinish();
    }

    _maybeFinish() {
        if (this._state !== 'running' || this._completeScheduled) return;
        if (this._ops.length || this._pending > 0) return;
        this._completeScheduled = true;
        setTimeout(() => {
            this._completeScheduled = false;
            if (this._state !== 'running' || this._ops.length || this._pending > 0) return;
            if (this._aborted) this._finishAbort();
            else this._commit();
        }, 0);
    }

    _commit() {
        if (this._state !== 'running') return;
        for (const name of this.names) {
            const live = this.db._stores.get(name);
            if (!live) continue;
            const snapshot = this._snapshot.get(name);
            live.data.clear();
            for (const [key, value] of snapshot) live.data.set(key, value);
        }
        this._state = 'finished';
        this._snapshot.clear();
        this.oncomplete?.({ target: this });
        this.db._pump();
    }

    _abortNow(fromError = false) {
        if (this._aborted || this._state === 'finished') return;
        this._aborted = true;
        this._abortFromError = fromError;
        this._snapshot.clear();
        if (this._state === 'running') {
            if (this._ops.length) this._schedule();
            else this._maybeFinish();
        }
    }

    _finishAbort() {
        if (this._state === 'finished') return;
        this._state = 'finished';
        if (this._abortFromError) this.onerror?.({ target: this });
        this.onabort?.({ target: this });
        this.db._pump();
    }

    abort() {
        if (this._state === 'finished') return;
        this._abortNow(false);
        // 尚未開始的交易：先讓它被排程，才能依序發出 abort 事件。
        if (this._state === 'pending') this.db._pump();
    }
}

export class FakeObjectStore {
    constructor(tx, data, name) {
        this._tx = tx;
        this._data = data;
        this._name = name;
        this._indexes = data.indexes;
        this.name = data.name;
        this.keyPath = data.keyPath;
        this.indexNames = { contains: (value) => data.indexes.has(value) };
    }

    get transaction() {
        return this._tx;
    }

    /**
     * 測試注入：讓下一個 request 在「執行時」失敗，而不是 put() 同步丟出。
     * 這樣前面已排入的寫入真的會被套用，才能驗證交易中止要整批回滾。
     */
    injectFailure(message = 'injected request failure') {
        return this._tx._enqueue(() => { throw new Error(message); });
    }

    _map() {
        // versionchange 直接寫正式資料；一般交易讀寫自己的快照。
        return this._tx ? this._tx._dataFor(this._name) : this._data.data;
    }

    createIndex(name, keyPath) {
        this._indexes.set(name, keyPath);
        return { name, keyPath };
    }

    index(name) {
        const keyPath = this._indexes.get(name);
        if (!keyPath) throw new Error('NotFoundError: index ' + name);
        const tx = this._tx;
        const map = () => this._map();
        return {
            getAll: (value) => tx._enqueue(() => {
                const rows = [];
                for (const record of map().values()) {
                    if (sameKey(valueAtKeyPath(record, keyPath), value)) rows.push(clone(record));
                }
                return rows;
            }),
            count: (value) => tx._enqueue(() => {
                let total = 0;
                for (const record of map().values()) {
                    if (sameKey(valueAtKeyPath(record, keyPath), value)) total += 1;
                }
                return total;
            })
        };
    }

    get(key) {
        return this._tx._enqueue(() => {
            const value = this._map().get(String(key));
            return value === undefined ? undefined : clone(value);
        });
    }

    getAll() {
        return this._tx._enqueue(() => Array.from(this._map().values(), clone));
    }

    count() {
        return this._tx._enqueue(() => this._map().size);
    }

    put(value, key) {
        const derived = this.keyPath ? valueAtKeyPath(value, this.keyPath) : key;
        if (derived === undefined || derived === null || derived === '') {
            throw new Error('DataError: missing key');
        }
        return this._tx._enqueue(() => {
            const stored = clone(value);
            this._map().set(String(derived), stored);
            return derived;
        });
    }

    delete(key) {
        return this._tx._enqueue(() => {
            this._map().delete(String(key));
            return undefined;
        });
    }
}

class FakeDatabase {
    constructor(name) {
        this.name = name;
        this.version = 0;
        this._stores = new Map();
        this._queue = [];
        this._active = [];
        this.onversionchange = null;
        this.onclose = null;
        this.objectStoreNames = {
            contains: (storeName) => this._stores.has(storeName),
            get length() { return this._stores.size; },
            [Symbol.iterator]: () => this._stores.keys()
        };
    }

    _pump() {
        this._active = this._active.filter((tx) => tx._state !== 'finished');
        for (let index = 0; index < this._queue.length; index += 1) {
            const tx = this._queue[index];
            if (tx._state !== 'pending') {
                this._queue.splice(index, 1);
                index -= 1;
                continue;
            }
            if (this._active.some((active) => active._overlaps(tx))) continue;
            // 後面的交易不得越過前面尚未開始的重疊交易（真實 IndexedDB 的
            // 建立順序保證）；不重疊的仍可並行。
            const earlierOverlap = this._queue.slice(0, index).some((earlier) => earlier._state === 'pending' && earlier._overlaps(tx));
            if (earlierOverlap) continue;
            this._queue.splice(index, 1);
            index -= 1;
            this._active.push(tx);
            tx._start();
        }
    }

    createObjectStore(name, options = {}) {
        if (this._stores.has(name)) throw new Error('ConstraintError: store exists');
        const data = {
            name,
            keyPath: options.keyPath || null,
            indexes: new Map(),
            data: new Map()
        };
        this._stores.set(name, data);
        return new FakeObjectStore(null, data, name);
    }

    transaction(names, mode = 'readonly') {
        return new FakeTransaction(this, Array.isArray(names) ? names : [names], mode);
    }

    close() {
        this.onclose?.({ target: this });
    }
}

export function createFakeIndexedDB() {
    const databases = new Map();
    return {
        open(name, version = 1) {
            const request = new FakeRequest();
            setTimeout(() => {
                let db = databases.get(name);
                const oldVersion = db ? db.version : 0;
                if (!db) {
                    db = new FakeDatabase(name);
                    databases.set(name, db);
                }
                request.result = db;
                if (oldVersion < version) {
                    db.version = version;
                    const upgrade = new FakeTransaction(db, [], 'versionchange');
                    request.transaction = upgrade;
                    request.onupgradeneeded?.({ oldVersion, newVersion: version, target: request });
                    // upgrade 交易本身不承載 request；建立完成後直接完成。
                    upgrade._state = 'finished';
                }
                request.onsuccess?.({ target: request });
            }, 0);
            return request;
        },
        deleteDatabase(name) {
            const request = new FakeRequest();
            setTimeout(() => {
                databases.delete(name);
                request.onsuccess?.({ target: request });
            }, 0);
            return request;
        },
        _databases: databases
    };
}
