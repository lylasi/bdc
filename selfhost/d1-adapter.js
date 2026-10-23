// 讓 selfhost 的資料庫介面看起來像 Cloudflare D1。
//
// 文章 API 只實作一份（cloudflare-worker/src/articles.js），selfhost 透過這個
// 轉接層共用同一份路由、同一份 SQL 與同一份錯誤碼，避免兩個後端各自演化出
// 不同行為。轉接層只負責：
//   1. prepare/bind/first/run/all → all/get/run
//   2. batch(transaction) → BEGIN / COMMIT / ROLLBACK（SQLite 與 PostgreSQL）
//   3. Node 的 IncomingMessage → 標準 Request（handleArticlesRoute 只吃 Web API）

/**
 * 把 node:sqlite 的 DatabaseSync 包成 server.mjs／測試共用的資料庫介面。
 * SQL 一律使用 `?` 佔位符；這裡直接轉給 node:sqlite。
 */
export function createSqliteDatabase(db) {
    return {
        driver: 'sqlite',
        all: async (sql, params = []) => db.prepare(sql).all(...params),
        get: async (sql, params = []) => db.prepare(sql).get(...params),
        run: async (sql, params = []) => {
            const result = db.prepare(sql).run(...params);
            return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
        },
        // 單一交易內依序執行；任何一句失敗就整批回滾（與 D1 batch 的語意一致）。
        batch: async (statements = []) => {
            const results = [];
            db.exec('BEGIN IMMEDIATE');
            try {
                for (const statement of statements) {
                    const result = db.prepare(statement.sql).run(...(statement.params || []));
                    results.push({ changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid });
                }
                db.exec('COMMIT');
                return results;
            } catch (error) {
                try { db.exec('ROLLBACK'); } catch (_) {}
                throw error;
            }
        },
        close: async () => db.close()
    };
}

export function createD1Adapter(db) {
    function bindStatement(sql) {
        const statement = {
            __sql: sql,
            __args: [],
            bind(...values) { this.__args = values; return this; },
            first() { return db.get(statement.__sql, statement.__args); },
            // D1 的 all() 回傳 { results: [...] }；selfhost 介面回傳純陣列。
            async all() { return { results: await db.all(statement.__sql, statement.__args) }; },
            // 補上 D1 的 meta.changes 形狀，讓共用路由不必判斷是哪個後端。
            async run() {
                const result = await db.run(statement.__sql, statement.__args);
                return { ...result, meta: { changes: result.changes } };
            }
        };
        return statement;
    }
    return {
        // 共用路由靠這個欄位判斷是否需要 PostgreSQL 專屬的交易內列鎖。
        driver: db.driver || '',
        prepare: (sql) => bindStatement(sql),
        batch: async (statements) => {
            const results = await db.batch(statements.map((statement) => ({
                sql: statement.__sql,
                params: statement.__args || []
            })));
            return results.map((result) => ({ ...result, meta: { changes: result.changes } }));
        }
    };
}

/**
 * 把 Node 的請求包成標準 Request。body 只讀一次，因此呼叫端要先讀好再傳入。
 */
export function toWebRequest({ method, url, headers, bodyText }) {
    const init = { method, headers: {} };
    const contentType = headers && headers['content-type'];
    if (contentType) init.headers['Content-Type'] = contentType;
    if (headers && headers.origin) init.headers.Origin = headers.origin;
    if (bodyText !== undefined && method !== 'GET' && method !== 'HEAD') {
        init.body = bodyText;
        if (!init.headers['Content-Type']) init.headers['Content-Type'] = 'application/json';
    }
    return new Request(url, init);
}

export async function readResponseBody(response) {
    const text = await response.text();
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch (_) {
        return text;
    }
}
