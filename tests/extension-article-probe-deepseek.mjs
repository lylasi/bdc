// DeepSeek 定向診斷：擴充套件 0.5.0「AI 提取本頁文章」前的既有文章預查
// （extension/workspace-ui.js extract() → modules/extension-workspace.js findExistingPageArticle()
//  → GET /vocabulary/books?sourceUrl= + POST /vocabulary/page-link）。
//
// 目的：只回答「後端／SQL／路由／正規化這一層到底會不會讓預查失敗、失敗時是以
// HTTP 錯誤還是連線錯誤的形式出現」，不改產品檔，也不重跑歷史套件。
//
// 受測的都是真產品程式碼：cloudflare-worker/src/worker.js（真路由）、
// cloudflare-worker/schema.sql（真 D1 schema）、selfhost/d1-adapter.js（真 SQLite 轉接層）。
// 唯一自行加入的是 SQL 統計包裝（只計列數，不改語意）與錯誤注入。
//
// 執行：node --test tests/extension-article-probe-deepseek.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import worker from '../cloudflare-worker/src/worker.js';
import { createD1Adapter, createSqliteDatabase } from '../selfhost/d1-adapter.js';
import { pageUrlKey } from '../shared/page-protocol.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = readFileSync(path.join(ROOT, 'cloudflare-worker/schema.sql'), 'utf8');
const ORIGIN = 'chrome-extension://deepseek-article-probe';
const TOKEN = 'p'.repeat(43);
const USER = 'probe-user';
const PAGE = 'https://news.example/story/7?edition=hk';
const OTHER_PAGE = 'https://news.example/story/9';

const stamp = new Date(Date.now() + 8 * 3600000).toISOString().replace(/\D/g, '').slice(0, 17);
const OUT = process.env.ARTICLE_PROBE_OUTPUT || path.join(ROOT, 'docs/report/assets', stamp + '_article-probe-deepseek');
const findings = [];
function record(name, detail) {
    findings.push({ name, detail });
    console.log('[probe] ' + name + ' :: ' + JSON.stringify(detail));
}

/* ------------------------------------------------------------------ *
 * 後端：真 schema + 真 D1 轉接層 + 真 Worker，DB 前加一層「只統計」的包裝
 * ------------------------------------------------------------------ */
function createBackend() {
    const raw = new DatabaseSync(':memory:');
    raw.exec(SCHEMA);
    raw.prepare('INSERT INTO users(token_hash,user_id,label,role) VALUES(?,?,?,?)')
        .run(createHash('sha256').update(TOKEN).digest('hex'), USER, USER, 'user');
    const stats = { queries: [] };
    // 只包 prepare→all 的列數，不改任何 SQL 或回傳值。
    const counted = {
        prepare(sql) {
            const statement = raw.prepare(sql);
            return {
                all: (...args) => {
                    const rows = statement.all(...args);
                    stats.queries.push({ sql: sql.replace(/\s+/g, ' ').slice(0, 150), rows: rows.length });
                    return rows;
                },
                get: (...args) => statement.get(...args),
                run: (...args) => statement.run(...args)
            };
        },
        exec: (sql) => raw.exec(sql),
        close: () => raw.close()
    };
    const DB = createD1Adapter(createSqliteDatabase(counted));
    return {
        raw, stats, DB,
        env: { DB, ALLOWED_ORIGINS: ORIGIN },
        reset() { stats.queries.length = 0; },
        rowsRead() { return stats.queries.reduce((total, entry) => total + entry.rows, 0); }
    };
}

function insertArticle(backend, { id, sourceUrl, legacyId = null, title = 'Story', deletedAt = null, body = '# Story\n\nBody.' }) {
    backend.raw.prepare('INSERT INTO articles (owner_user_id, id, title, body, analysis_json, source_type, source_url, revision, '
        + 'created_at, updated_at, deleted_at, legacy_article_id, last_mutation_id, size_bytes) '
        + 'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(USER, id, title, body, null, 'url', sourceUrl, 1, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z',
            deletedAt, legacyId, 'seed', Buffer.byteLength(body, 'utf8'));
}

async function call(backend, path, { method = 'GET', body, token = TOKEN, origin = ORIGIN } = {}) {
    const headers = { Origin: origin };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return worker.fetch(new Request('https://sync.example' + path, {
        method, headers, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) })
    }), backend.env);
}

const booksUrl = (sourceUrl) => '/vocabulary/books?sourceUrl=' + encodeURIComponent(sourceUrl);
const corsOf = (response) => response.headers.get('Access-Control-Allow-Origin');
const jsonOf = async (response) => {
    const text = await response.text();
    try { return JSON.parse(text); } catch (_) { return { __raw: text.slice(0, 200) }; }
};

/* ================================================================== *
 * P1 契約：GET ?sourceUrl= 是既有文章預查的唯一後端入口
 * ================================================================== */
test('P1 既有文章預查：?sourceUrl= 回傳 articleId，沒有文章時回空字串', async (t) => {
    const backend = createBackend();
    t.after(() => backend.raw.close());
    insertArticle(backend, { id: 'art_probe_1', sourceUrl: PAGE });

    const found = await call(backend, booksUrl(PAGE));
    const foundBody = await jsonOf(found);
    assert.equal(found.status, 200);
    assert.equal(foundBody.articleId, 'art_probe_1', '已存在文章應回 articleId（extension 據此顯示「沿用」入口）');
    assert.equal(corsOf(found), ORIGIN);
    record('P1 既有文章命中', { status: found.status, articleId: foundBody.articleId, cors: corsOf(found) });

    const missing = await call(backend, booksUrl(OTHER_PAGE));
    const missingBody = await jsonOf(missing);
    assert.equal(missing.status, 200);
    assert.equal(missingBody.articleId, '', '沒有文章時必須是 200 加空 articleId，而不是錯誤');
    record('P1 沒有文章時', { status: missing.status, articleId: missingBody.articleId });

    // 不帶 sourceUrl 的清單（擴充套件啟動時讀詞書用的那一支）不會碰到文章查詢。
    backend.reset();
    const plain = await call(backend, '/vocabulary/books');
    const plainBody = await jsonOf(plain);
    assert.equal(plain.status, 200);
    const plainSql = backend.stats.queries.map((entry) => entry.sql);
    assert.ok(plainSql.every((sql) => !/FROM articles/.test(sql)), '不帶 sourceUrl 時不應查 articles');
    record('P1 不帶 sourceUrl 的清單', { status: plain.status, books: plainBody.books.length, queries: plainSql });
});

/* ================================================================== *
 * P2 URL 正規化：兩端都用 pageUrlKey 比對
 * ================================================================== */
test('P2 URL 正規化：fragment／尾斜線在兩端的實際比對結果', async (t) => {
    const backend = createBackend();
    t.after(() => backend.raw.close());
    insertArticle(backend, { id: 'art_probe_frag', sourceUrl: PAGE });

    // 擴充套件送出的是 location.href，可能帶 #fragment；encodeURIComponent 會把它變成 %23。
    const withFragment = await call(backend, booksUrl(PAGE + '#comments'));
    assert.equal((await jsonOf(withFragment)).articleId, 'art_probe_frag', '非 #!/ 的 fragment 應被 pageUrlKey 去掉後命中');

    // 尾斜線不是同一個 key：這不是錯誤，但會讓「同一頁」變成兩篇文章。
    insertArticle(backend, { id: 'art_probe_slash', sourceUrl: 'https://news.example/story/8/' });
    const noSlash = await jsonOf(await call(backend, booksUrl('https://news.example/story/8')));
    assert.equal(noSlash.articleId, '', 'pageUrlKey 不會補／去尾斜線，https://x/a 與 https://x/a/ 是不同 key');
    record('P2 URL 正規化', {
        fragmentKey: pageUrlKey(PAGE + '#comments'), baseKey: pageUrlKey(PAGE),
        slashKey: pageUrlKey('https://news.example/story/8/'), noSlashKey: pageUrlKey('https://news.example/story/8'),
        note: 'fragment 一致；尾斜線不一致（不影響阻塞，但會讓同頁重複建文章）'
    });

    // 舊網址文章的公開 ID（url:…）也要能被接受，否則前端 isValidArticleReference 會擋。
    insertArticle(backend, { id: 'art_probe_legacy', sourceUrl: OTHER_PAGE, legacyId: 'url:' + encodeURIComponent(OTHER_PAGE) });
    const legacy = await jsonOf(await call(backend, booksUrl(OTHER_PAGE)));
    assert.equal(legacy.articleId, 'url:' + encodeURIComponent(OTHER_PAGE), 'findPageArticle 以 legacy_article_id 為公開 ID');
    record('P2 legacy 公開 ID', { articleId: legacy.articleId });
});

/* ================================================================== *
 * P3 超長網址：後端視為無效 key，但仍回 200
 * ================================================================== */
test('P3 超過 2048 字元的網址：後端回 200 加空 articleId，不會 5xx', async (t) => {
    const backend = createBackend();
    t.after(() => backend.raw.close());
    const longPage = 'https://news.example/story/long?' + 'q=' + 'x'.repeat(2200);
    const response = await call(backend, booksUrl(longPage));
    const body = await jsonOf(response);
    assert.equal(response.status, 200);
    assert.equal(body.articleId, '');
    record('P3 超長網址', {
        urlLength: longPage.length, encodedLength: encodeURIComponent(longPage).length,
        pageUrlKey: pageUrlKey(longPage), status: response.status, articleId: body.articleId
    });
});

/* ================================================================== *
 * P4 後端 SQL／schema 失敗：是 HTTP 500 JSON，不是連線失敗
 * ================================================================== */
test('P4 後端 SQL 失敗時回 500 JSON + CORS（來源是 HTTP 錯誤，不是「連不上」）', async (t) => {
    const backend = createBackend();
    t.after(() => backend.raw.close());
    insertArticle(backend, { id: 'art_probe_500', sourceUrl: PAGE });

    // 模擬「正式 D1 與部署版本／遷移不一致」：預查依賴的 articles 表讀不到。
    backend.raw.exec('ALTER TABLE articles RENAME TO articles_hidden');
    try {
        const broken = await call(backend, booksUrl(PAGE));
        const brokenBody = await jsonOf(broken);
        assert.equal(broken.status, 500, '後端會把預查例外轉成 500 capture_failed');
        assert.equal(brokenBody.code, 'capture_failed');
        assert.equal(corsOf(broken), ORIGIN, '500 仍帶 CORS：瀏覽器看到的是 HTTP 錯誤，不是 CORS／連線失敗');
        record('P4 預查 SQL 失敗', {
            status: broken.status, code: brokenBody.code, cors: corsOf(broken),
            note: '擴充套件端 findExistingPageArticle 會把這個 500 當成「操作失敗」，apiRequest 只在 fetch 本身拋錯時才給 sync_unreachable'
        });

        // 同一時間，不帶 sourceUrl 的清單仍正常：證明「故障只在 sourceUrl 分支」。
        const plain = await call(backend, '/vocabulary/books');
        assert.equal(plain.status, 200, '不帶 sourceUrl 的詞書清單不受 articles 影響');
        record('P4 同期清單仍 200', { status: plain.status });
    } finally {
        backend.raw.exec('ALTER TABLE articles_hidden RENAME TO articles');
    }

    const recovered = await jsonOf(await call(backend, booksUrl(PAGE)));
    assert.equal(recovered.articleId, 'art_probe_500');
});

/* ================================================================== *
 * P5 page-link 競態：GET 說有文章，POST 前被刪 → 404
 * ================================================================== */
test('P5 預查第二步 page-link 的競態：文章在兩次呼叫之間被刪 → 404 article_not_found', async (t) => {
    const backend = createBackend();
    t.after(() => backend.raw.close());
    insertArticle(backend, { id: 'art_probe_race', sourceUrl: PAGE });

    const first = await jsonOf(await call(backend, booksUrl(PAGE)));
    assert.equal(first.articleId, 'art_probe_race');

    backend.raw.prepare('UPDATE articles SET deleted_at = ? WHERE owner_user_id = ? AND id = ?')
        .run('2026-11-02T00:00:00.000Z', USER, 'art_probe_race');

    const linked = await call(backend, '/vocabulary/page-link', { method: 'POST', body: { sourceUrl: PAGE } });
    const linkedBody = await jsonOf(linked);
    assert.equal(linked.status, 404);
    assert.equal(linkedBody.code, 'article_not_found');
    record('P5 page-link 競態', {
        status: linked.status, code: linkedBody.code,
        note: 'findExistingPageArticle 會 throw（errorKeys 沒有這個碼 → 落到通用「操作未完成」），AI 一樣不會跑'
    });
});

/* ================================================================== *
 * P6 成本：每次預查都是全表掃描
 * ================================================================== */
test('P6 成本：?sourceUrl= 每次都把該帳戶全部文章與詞書讀出來', async (t) => {
    const backend = createBackend();
    t.after(() => backend.raw.close());
    const ARTICLES = 1000; // ARTICLE_LIMITS.maxCount 的硬上限
    const BOOKS = 200;
    const seed = backend.raw.prepare('INSERT INTO articles (owner_user_id, id, title, body, analysis_json, source_type, source_url, '
        + 'revision, created_at, updated_at, deleted_at, legacy_article_id, last_mutation_id, size_bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    backend.raw.exec('BEGIN');
    for (let index = 0; index < ARTICLES; index += 1) {
        seed.run(USER, 'art_bulk_' + index, 'Title ' + index, 'body ' + index, null, 'url',
            'https://news.example/bulk/' + index, 1, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', null, null, 'seed', 32);
    }
    const book = backend.raw.prepare('INSERT INTO reading_entities VALUES(?,?,?,?,?,?,?,?)');
    for (let index = 0; index < BOOKS; index += 1) {
        book.run(USER, 'vocabularyBook', 'book_' + index, 1, null, JSON.stringify({ name: 'b' + index }), '2026-11-01', 'seed');
    }
    backend.raw.exec('COMMIT');

    backend.reset();
    const started = performance.now();
    const response = await call(backend, booksUrl('https://news.example/bulk/999'));
    const elapsed = performance.now() - started;
    const body = await jsonOf(response);
    assert.equal(response.status, 200);
    assert.equal(body.articleId, 'art_bulk_999');

    const articleQuery = backend.stats.queries.find((entry) => /FROM articles/.test(entry.sql));
    assert.ok(articleQuery && articleQuery.rows >= ARTICLES, 'findPageArticle 讀出全部文章再在 JS 端比對');
    record('P6 預查成本', {
        articles: ARTICLES, books: BOOKS, rowsRead: backend.rowsRead(), elapsedMs: Number(elapsed.toFixed(2)),
        queries: backend.stats.queries,
        note: '每次按「AI 提取本頁文章」都會重跑一次；SQL 沒有 source_url 索引，比對在 JS 端做'
    });
});

/* ================================================================== *
 * P7 認證／CORS 基線：路由存在且格式正確
 * ================================================================== */
test('P7 認證與 CORS 基線：無 token → 401 JSON；OPTIONS → 204', async (t) => {
    const backend = createBackend();
    t.after(() => backend.raw.close());
    insertArticle(backend, { id: 'art_probe_auth', sourceUrl: PAGE });

    const anonymous = await call(backend, booksUrl(PAGE), { token: '' });
    const anonymousBody = await jsonOf(anonymous);
    assert.equal(anonymous.status, 401);
    assert.equal(anonymousBody.code, 'unauthorized');
    assert.equal(corsOf(anonymous), ORIGIN);
    record('P7 無 token', { status: anonymous.status, code: anonymousBody.code, cors: corsOf(anonymous) });

    const preflight = await call(backend, booksUrl(PAGE), { method: 'OPTIONS', token: '' });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Headers'), 'Authorization, Content-Type');
    record('P7 預檢', {
        status: preflight.status,
        allowHeaders: preflight.headers.get('Access-Control-Allow-Headers'),
        allowOrigin: preflight.headers.get('Access-Control-Allow-Origin')
    });
});

/* ================================================================== *
 * P8 畸形 sourceUrl：不得 5xx
 * ================================================================== */
test('P8 畸形或惡意 sourceUrl 不會 5xx', async (t) => {
    const backend = createBackend();
    t.after(() => backend.raw.close());
    const cases = ['', 'not a url', 'javascript:alert(1)', 'chrome://extensions', 'https://', 'https://user:pw@news.example/x'];
    const results = [];
    for (const value of cases) {
        const response = await call(backend, '/vocabulary/books?sourceUrl=' + encodeURIComponent(value));
        const body = await jsonOf(response);
        results.push({ value, status: response.status, articleId: body.articleId });
    }
    const missingParam = await call(backend, '/vocabulary/books');
    results.push({ value: '<missing>', status: missingParam.status });
    record('P8 畸形 sourceUrl', results);
    assert.ok(results.every((entry) => entry.status === 200), JSON.stringify(results));
});

/* ================================================================== *
 * 產出 artifacts
 * ================================================================== */
test('P9 產出診斷 artifact', async () => {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(path.join(OUT, 'worker-probe-findings.json'), JSON.stringify({ stamp, origin: ORIGIN, findings }, null, 2));
    console.log('[probe] artifact: ' + path.join(OUT, 'worker-probe-findings.json'));
});
