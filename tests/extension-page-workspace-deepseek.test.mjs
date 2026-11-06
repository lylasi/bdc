// DeepSeek 定向測試：擴充套件「本頁／自訂／預設詞書」與「同頁文章自動關聯」。
//
// 受測的都是真實程式碼，沒有 SQL 鏡像、沒有 mock：
//   - cloudflare-worker/src/worker.js 的真實路由與授權
//   - cloudflare-worker/src/captures.js、capture-books.js、page-links.js
//   - cloudflare-worker/src/articles.js（POST/PUT /articles）
//   - node:sqlite + selfhost/d1-adapter.js（與正式 selfhost 相同的 D1 轉接層）
//   - cloudflare-worker/schema.sql（含 migration 008 的 vocabulary_capture_settings）
//
// 每個測試使用獨立的 :memory: 資料庫與獨立帳戶，避免 http.js 的模組層限流桶
// 互相污染；所有帳號都由測試自建，不連正式 Worker、不讀私有設定。
//
// 覆蓋範圍：
//   1. 授權與帳戶隔離
//   2. page／custom 書的差異、URL 穩定 ID、沿用本頁既有書
//   3. 預設書：建立即設為預設、PUT 換預設、刪除後無預選、跨帳戶互不影響
//   4. ledger 冪等：重播逐欄回原回執、改 body 409、刪書重播不復活、並行同 URL
//   5. 輸入驗證（名稱長度、requestId、網址、kind）
//   6. 閱讀游標：建書推進一格、預設書寫入不擾動游標
//   7. 文章關聯：先書後文／先文後書／舊文章沿用／不同 URL 不誤聯／刪文不關聯／重試不重複
//   8. 來源 hash 路由必須保留區分

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import worker from '../cloudflare-worker/src/worker.js';
import { createD1Adapter, createSqliteDatabase } from '../selfhost/d1-adapter.js';
import { linkPageVocabularyBooks } from '../cloudflare-worker/src/page-links.js';

const root = new URL('..', import.meta.url);
const ORIGIN = 'chrome-extension://probe';
const BASE = 'https://sync.example';
// 尾端是普通片段（會被 pageUrlKey 忽略），用來測網址正規化。
const PAGE = 'https://news.example/story/42?edition=hk';
const PAGE_WITH_FRAGMENT = 'https://news.example/story/42?edition=hk#comments';
const OTHER_PAGE = 'https://news.example/story/99';

let userSeq = 0;

/** 真 SQLite + 真 D1 adapter + 真實 Worker；每個測試一套獨立資料庫與帳戶。 */
function setup(t) {
    userSeq += 1;
    const db = new DatabaseSync(':memory:');
    db.exec(readFileSync(new URL('cloudflare-worker/schema.sql', root), 'utf8'));
    const accounts = {
        alice: { id: `ds${userSeq}alice`, token: `deepseek-alice-${userSeq}-${'a'.repeat(24)}` },
        bob: { id: `ds${userSeq}bob`, token: `deepseek-bob-${userSeq}-${'b'.repeat(24)}` }
    };
    for (const account of Object.values(accounts)) {
        db.prepare('INSERT INTO users(token_hash,user_id,role) VALUES(?,?,?)')
            .run(createHash('sha256').update(account.token).digest('hex'), account.id, 'user');
    }
    const env = { DB: createD1Adapter(createSqliteDatabase(db)), ALLOWED_ORIGINS: ORIGIN };
    t.after(() => db.close());
    return { db, env, alice: accounts.alice, bob: accounts.bob };
}

/** 直接寫入一筆閱讀實體，模擬網站端既有的舊資料。 */
function seed(db, owner, type, id, data, revision = 1, deleted = null) {
    db.prepare('INSERT OR REPLACE INTO reading_entities VALUES(?,?,?,?,?,?,?,?)')
        .run(owner, type, id, revision, deleted, JSON.stringify(data), '2026-11-01T00:00:00Z', 'seed');
}

async function request(env, path, { method = 'GET', body, token, origin = ORIGIN } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (origin) headers.Origin = origin;
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await worker.fetch(new Request(BASE + path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }), env);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
}

function createBook(env, account, body) {
    return request(env, '/vocabulary/books', { method: 'POST', token: account.token, body });
}

function listBooks(env, account, sourceUrl) {
    const suffix = sourceUrl === undefined ? '' : `?sourceUrl=${encodeURIComponent(sourceUrl)}`;
    return request(env, `/vocabulary/books${suffix}`, { token: account.token });
}

function setDefault(env, account, bookId) {
    return request(env, '/vocabulary/default', { method: 'PUT', token: account.token, body: { bookId } });
}

function createArticle(env, account, { id, title = '測試文章', body = '文章正文內容', sourceUrl, mutationId, sourceType = 'url' }) {
    return request(env, '/articles', {
        method: 'POST',
        token: account.token,
        body: { ...(id ? { id } : {}), title, body, sourceType, ...(sourceUrl ? { sourceUrl } : {}), ...(mutationId ? { clientMutationId: mutationId } : {}) }
    });
}

function capture(env, account, body) {
    return request(env, '/captures', {
        method: 'POST',
        token: account.token,
        body: { requestId: 'capture-1', word: 'plunge', meaning: '暴跌', ...body }
    });
}

function deleteBook(env, account, bookId, revision) {
    return request(env, '/reading/mutations', {
        method: 'POST',
        token: account.token,
        body: {
            mutations: [{
                mutationId: `delete-${bookId}-${revision}`,
                entityType: 'vocabularyBook',
                entityId: bookId,
                op: 'delete',
                expectedRevision: revision
            }]
        }
    });
}

function bookRow(db, owner, id) {
    const row = db.prepare("SELECT * FROM reading_entities WHERE owner_user_id=? AND entity_type='vocabularyBook' AND entity_id=?")
        .get(owner, id);
    if (!row) return null;
    return {
        ...JSON.parse(row.data_json || '{}'),
        revision: Number(row.revision),
        deletedAt: row.deleted_at || '',
        lastMutationId: row.last_mutation_id || ''
    };
}

function changeRows(db, owner, type = '') {
    return type
        ? db.prepare('SELECT * FROM reading_changes WHERE owner_user_id=? AND entity_type=? ORDER BY seq').all(owner, type)
        : db.prepare('SELECT * FROM reading_changes WHERE owner_user_id=? ORDER BY seq').all(owner);
}

function receiptCount(db, owner) {
    return Number(db.prepare('SELECT COUNT(*) AS n FROM vocabulary_captures WHERE owner_user_id=?').get(owner).n);
}

function settingsRow(db, owner) {
    return db.prepare('SELECT default_book_id FROM vocabulary_capture_settings WHERE owner_user_id=?').get(owner) || null;
}

function bookIds(body) {
    return (body.books || []).map((book) => book.id).sort();
}

// ── 1. 授權與帳戶隔離 ────────────────────────────────────────────────────────

test('新詞書端點在未登入／非法來源時不建立任何資料', async (t) => {
    const { db, env, alice } = setup(t);
    const body = { requestId: 'req-1', name: '頁面詞書', kind: 'page', sourceUrl: PAGE };
    for (const path of ['/vocabulary/books', '/vocabulary/default']) {
        const method = path === '/vocabulary/default' ? 'PUT' : 'POST';
        assert.equal((await request(env, path, { method, body, token: '' })).status, 401, `${method} ${path} 未登入須 401`);
        assert.equal((await request(env, path, { method, body, token: 'not-a-real-token' })).status, 401, `${method} ${path} 偽造 token 須 401`);
        assert.equal((await request(env, path, { method, body, token: alice.token, origin: 'https://evil.example' })).status, 403, `${method} ${path} 非法 Origin 須 403`);
    }
    assert.equal((await listBooks(env, { token: '' }, PAGE)).status, 401, 'GET 詞書清單未登入須 401');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reading_entities WHERE entity_type='vocabularyBook'").get().n, 0);
    assert.equal(receiptCount(db, alice.id), 0);
    assert.equal(settingsRow(db, alice.id), null);
});

test('詞書清單與預設值按帳戶隔離，不洩漏他人書名與頁書', async (t) => {
    const { env, db, alice, bob } = setup(t);
    const aliceBook = await createBook(env, alice, { requestId: 'alice-page', name: '愛麗絲的本頁書', kind: 'page', sourceUrl: PAGE, makeDefault: true });
    assert.equal(aliceBook.status, 200, JSON.stringify(aliceBook));
    const bobList = await listBooks(env, bob, PAGE);
    assert.equal(bobList.status, 200);
    assert.deepEqual(bobList.body, { books: [], defaultBookId: '', pageBookId: '', articleId: '' });
    assert.equal(bookRow(db, bob.id, aliceBook.body.bookId), null, '不得在他人帳戶建立同 ID 的書');
    const aliceList = await listBooks(env, alice, PAGE);
    assert.deepEqual(bookIds(aliceList.body), [aliceBook.body.bookId]);
    assert.equal(aliceList.body.defaultBookId, aliceBook.body.bookId);
    assert.equal(aliceList.body.pageBookId, aliceBook.body.bookId);
});

test('不能把他人的書設為自己的預設，也不影響對方設定', async (t) => {
    const { env, db, alice, bob } = setup(t);
    const aliceBook = await createBook(env, alice, { requestId: 'alice-page', name: '愛麗絲書', kind: 'page', sourceUrl: PAGE, makeDefault: true });
    const stolen = await setDefault(env, bob, aliceBook.body.bookId);
    assert.equal(stolen.status, 404);
    assert.equal(stolen.body.code, 'capture_target_missing');
    assert.equal(settingsRow(db, bob.id), null);
    assert.equal(settingsRow(db, alice.id).default_book_id, aliceBook.body.bookId);
});

// ── 2. page 與 custom 書的差異 ──────────────────────────────────────────────

test('書名會去除前後空白後保存，內部空白與非 ASCII 保留', async (t) => {
    const { env, db, alice } = setup(t);
    const created = await createBook(env, alice, { requestId: 'name-1', name: '  我的 生詞本  ', kind: 'custom' });
    assert.equal(created.status, 200);
    assert.equal(bookRow(db, alice.id, created.body.bookId).name, '我的 生詞本');
});

test('page 書按正規化網址穩定：同 URL 不同 requestId 沿用同一本且不覆寫名稱', async (t) => {
    const { env, db, alice } = setup(t);
    const first = await createBook(env, alice, { requestId: 'page-a', name: '第一次命名', kind: 'page', sourceUrl: PAGE });
    const second = await createBook(env, alice, { requestId: 'page-b', name: '第二次命名', kind: 'page', sourceUrl: PAGE_WITH_FRAGMENT });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.body.created, true);
    assert.equal(second.body.created, false, '同 URL 第二次建立必須沿用既有本頁書');
    assert.equal(second.body.bookId, first.body.bookId);
    assert.match(first.body.bookId, /^webbook_[0-9a-f]{48}$/, 'page 書 ID 必須由網址雜湊穩定產生');
    const saved = bookRow(db, alice.id, first.body.bookId);
    assert.equal(saved.name, '第一次命名', '沿用既有書時不得覆寫名稱');
    assert.equal(saved.sourceUrl, PAGE, '網址必須以正規化形式保存（忽略 #comments 片段）');
    assert.equal(changeRows(db, alice.id, 'vocabularyBook').length, 1, '沿用既有書不得再推進一次變更');
});

test('custom 書不需要網址，ID 由 requestId 派生：同名不同 requestId 是兩本', async (t) => {
    const { env, db, alice } = setup(t);
    const first = await createBook(env, alice, { requestId: 'custom-a', name: '我的詞書', kind: 'custom' });
    const second = await createBook(env, alice, { requestId: 'custom-b', name: '我的詞書', kind: 'custom' });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.notEqual(first.body.bookId, second.body.bookId);
    assert.equal(first.body.created, true);
    assert.equal(second.body.created, true);
    assert.equal(bookRow(db, alice.id, first.body.bookId).sourceUrl, '');
    const listed = await listBooks(env, alice);
    assert.deepEqual(listed.body.books.map((book) => book.name).sort(), ['我的詞書', '我的詞書']);
    assert.equal(listed.body.pageBookId, '', '未指定 sourceUrl 時不得預選頁書');
});

test('custom 書帶同一個網址時，建 page 書會沿用該書並成為頁書', async (t) => {
    const { env, db, alice } = setup(t);
    const custom = await createBook(env, alice, { requestId: 'custom-1', name: '自訂命名', kind: 'custom', sourceUrl: PAGE });
    assert.equal(custom.status, 200);
    const page = await createBook(env, alice, { requestId: 'page-1', name: '頁面命名', kind: 'page', sourceUrl: PAGE });
    assert.equal(page.status, 200);
    assert.equal(page.body.bookId, custom.body.bookId);
    assert.equal(page.body.created, false);
    assert.equal(bookRow(db, alice.id, custom.body.bookId).name, '自訂命名');
    const listed = await listBooks(env, alice, PAGE);
    assert.equal(listed.body.pageBookId, custom.body.bookId);
});

test('兩個帳戶用同一個 requestId 各自建立各自的書（回執按帳戶隔離）', async (t) => {
    const { env, db, alice, bob } = setup(t);
    const body = { requestId: 'shared-1', name: '我的本頁', kind: 'page', sourceUrl: PAGE, makeDefault: true };
    const mine = await createBook(env, alice, body);
    const theirs = await createBook(env, bob, body);
    assert.equal(mine.status, 200);
    assert.equal(theirs.status, 200);
    assert.equal(mine.body.created, true);
    assert.equal(theirs.body.created, true);
    assert.equal(mine.body.bookId, theirs.body.bookId, '同網址的頁書 ID 由網址決定，跨帳戶可相同');
    assert.ok(bookRow(db, alice.id, mine.body.bookId));
    assert.ok(bookRow(db, bob.id, theirs.body.bookId));
    assert.equal(settingsRow(db, alice.id).default_book_id, mine.body.bookId);
    assert.equal(settingsRow(db, bob.id).default_book_id, theirs.body.bookId);
    assert.equal(receiptCount(db, alice.id), 1);
    assert.equal(receiptCount(db, bob.id), 1);
});

test('GET /vocabulary/books?sourceUrl 回傳本人書、頁書與頁文章，並排除墓碑', async (t) => {
    const { env, db, alice } = setup(t);
    const page = await createBook(env, alice, { requestId: 'page-1', name: '本頁', kind: 'page', sourceUrl: PAGE });
    const other = await createBook(env, alice, { requestId: 'page-2', name: '別頁', kind: 'page', sourceUrl: OTHER_PAGE });
    seed(db, alice.id, 'vocabularyBook', 'legacy-removed', { name: '已刪除', sourceUrl: PAGE }, 3, '2026-11-05T00:00:00Z');
    const listed = await listBooks(env, alice, PAGE);
    assert.equal(listed.status, 200);
    assert.deepEqual(bookIds(listed.body), [other.body.bookId, page.body.bookId].sort());
    assert.equal(listed.body.pageBookId, page.body.bookId);
    assert.equal(listed.body.articleId, '');
    const entry = listed.body.books.find((book) => book.id === page.body.bookId);
    assert.deepEqual(entry, { id: page.body.bookId, name: '本頁', revision: 1, sourceUrl: PAGE, articleId: '' });
});

test('新建的頁書可以立即收藏詞條', async (t) => {
    const { env, db, alice } = setup(t);
    const page = await createBook(env, alice, { requestId: 'page-1', name: '本頁', kind: 'page', sourceUrl: PAGE });
    const saved = await capture(env, alice, { requestId: 'cap-1', bookId: page.body.bookId, source: { sourceUrl: PAGE, sentence: 'Stocks plunge.' } });
    assert.equal(saved.status, 200, JSON.stringify(saved));
    assert.equal(saved.body.bookId, page.body.bookId);
    const stored = db.prepare("SELECT data_json FROM reading_entities WHERE owner_user_id=? AND entity_type='vocabularyEntry' AND entity_id=?")
        .get(alice.id, saved.body.entryId);
    assert.equal(JSON.parse(stored.data_json).bookId, page.body.bookId);
    const listed = await listBooks(env, alice, PAGE);
    assert.equal(listed.body.pageBookId, page.body.bookId);
});

// ── 3. 預設書 ───────────────────────────────────────────────────────────────

test('建書即設為預設；未指定 makeDefault 的新書不改動預設', async (t) => {
    const { env, db, alice } = setup(t);
    const first = await createBook(env, alice, { requestId: 'page-1', name: '本頁', kind: 'page', sourceUrl: PAGE, makeDefault: true });
    assert.equal(first.body.defaultBookId, first.body.bookId);
    assert.equal(settingsRow(db, alice.id).default_book_id, first.body.bookId);
    const second = await createBook(env, alice, { requestId: 'custom-1', name: '另一本', kind: 'custom' });
    assert.equal(second.status, 200);
    assert.equal(second.body.defaultBookId, '', '未要求改預設時不得回報新預設');
    assert.equal(settingsRow(db, alice.id).default_book_id, first.body.bookId);
    assert.equal((await listBooks(env, alice)).body.defaultBookId, first.body.bookId);
});

test('PUT /vocabulary/default 明確切換預設，且只影響自己', async (t) => {
    const { env, db, alice, bob } = setup(t);
    const bobBook = await createBook(env, bob, { requestId: 'bob-1', name: 'Bob書', kind: 'custom', makeDefault: true });
    const a = await createBook(env, alice, { requestId: 'a-1', name: 'A', kind: 'custom' });
    const b = await createBook(env, alice, { requestId: 'b-1', name: 'B', kind: 'custom', makeDefault: true });
    const moved = await setDefault(env, alice, a.body.bookId);
    assert.equal(moved.status, 200);
    assert.deepEqual(moved.body, { ok: true, defaultBookId: a.body.bookId });
    assert.equal((await listBooks(env, alice)).body.defaultBookId, a.body.bookId);
    assert.equal(settingsRow(db, alice.id).default_book_id, a.body.bookId);
    assert.equal(settingsRow(db, bob.id).default_book_id, bobBook.body.bookId, '他人預設不得被改動');
    assert.equal((await listBooks(env, bob)).body.defaultBookId, bobBook.body.bookId);
    assert.notEqual(a.body.bookId, b.body.bookId);
});

test('刪除預設書後清單不再預選；指向已刪書的 PUT 被拒絕', async (t) => {
    const { env, db, alice } = setup(t);
    const page = await createBook(env, alice, { requestId: 'page-1', name: '本頁', kind: 'page', sourceUrl: PAGE, makeDefault: true });
    const removed = await deleteBook(env, alice, page.body.bookId, 1);
    assert.equal(removed.status, 200, JSON.stringify(removed));
    assert.equal(removed.body.results[0].status, 'ok');
    const listed = await listBooks(env, alice, PAGE);
    assert.deepEqual(listed.body, { books: [], defaultBookId: '', pageBookId: '', articleId: '' });
    const rejected = await setDefault(env, alice, page.body.bookId);
    assert.equal(rejected.status, 404);
    assert.equal(rejected.body.code, 'capture_target_missing');
});

test('預設書被刪後，新建頁書可重新成為預設', async (t) => {
    const { env, db, alice } = setup(t);
    const first = await createBook(env, alice, { requestId: 'page-1', name: '本頁', kind: 'page', sourceUrl: OTHER_PAGE, makeDefault: true });
    assert.equal((await deleteBook(env, alice, first.body.bookId, 1)).status, 200);
    const second = await createBook(env, alice, { requestId: 'custom-2', name: '替代書', kind: 'custom', makeDefault: true });
    assert.equal(second.status, 200);
    assert.equal(second.body.created, true);
    assert.equal((await listBooks(env, alice)).body.defaultBookId, second.body.bookId);
    assert.equal(settingsRow(db, alice.id).default_book_id, second.body.bookId);
});

// ── 4. 冪等與並行 ───────────────────────────────────────────────────────────

test('相同 requestId 重播逐欄回原回執，只留一筆回執與一次變更', async (t) => {
    const { env, db, alice } = setup(t);
    const body = { requestId: 'page-1', name: '本頁', kind: 'page', sourceUrl: PAGE, makeDefault: true };
    const first = await createBook(env, alice, body);
    const replay = await createBook(env, alice, body);
    assert.deepEqual(replay, first, '重播必須逐欄相同');
    assert.equal(receiptCount(db, alice.id), 1);
    assert.equal(changeRows(db, alice.id, 'vocabularyBook').length, 1);
    assert.equal(settingsRow(db, alice.id).default_book_id, first.body.bookId);
});

test('相同 requestId 改 body 回 409，且不修改既有書與預設', async (t) => {
    const { env, db, alice } = setup(t);
    const created = await createBook(env, alice, { requestId: 'page-1', name: '原名', kind: 'page', sourceUrl: PAGE });
    for (const body of [
        { requestId: 'page-1', name: '改名', kind: 'page', sourceUrl: PAGE },
        { requestId: 'page-1', name: '原名', kind: 'custom' },
        { requestId: 'page-1', name: '原名', kind: 'page', sourceUrl: OTHER_PAGE },
        { requestId: 'page-1', name: '原名', kind: 'page', sourceUrl: PAGE, makeDefault: true }
    ]) {
        const conflict = await createBook(env, alice, body);
        assert.equal(conflict.status, 409, `${JSON.stringify(body)} 應為 409`);
        assert.equal(conflict.body.code, 'capture_request_mismatch');
    }
    assert.equal(bookRow(db, alice.id, created.body.bookId).name, '原名');
    assert.equal(changeRows(db, alice.id, 'vocabularyBook').length, 1);
    assert.equal(settingsRow(db, alice.id), null);
});

test('預設已被別的操作改掉後，舊 requestId 重播不會把預設改回來', async (t) => {
    const { env, db, alice } = setup(t);
    const page = await createBook(env, alice, { requestId: 'page-1', name: '本頁', kind: 'page', sourceUrl: PAGE, makeDefault: true });
    const other = await createBook(env, alice, { requestId: 'custom-1', name: '另一本', kind: 'custom', makeDefault: true });
    assert.equal(settingsRow(db, alice.id).default_book_id, other.body.bookId);
    const replay = await createBook(env, alice, { requestId: 'page-1', name: '本頁', kind: 'page', sourceUrl: PAGE, makeDefault: true });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.defaultBookId, page.body.bookId, '回執是歷史事實，仍記著當時的預設');
    assert.equal(settingsRow(db, alice.id).default_book_id, other.body.bookId, '重播不得把預設改回來');
    assert.equal((await listBooks(env, alice)).body.defaultBookId, other.body.bookId);
});

test('刪書後重播同一 requestId 回原回執，不復活、不推進 revision', async (t) => {
    const { env, db, alice } = setup(t);
    const body = { requestId: 'page-1', name: '本頁', kind: 'page', sourceUrl: PAGE };
    const first = await createBook(env, alice, body);
    assert.equal((await deleteBook(env, alice, first.body.bookId, 1)).status, 200);
    const before = changeRows(db, alice.id, 'vocabularyBook').length;
    const replay = await createBook(env, alice, body);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, first.body);
    const saved = bookRow(db, alice.id, first.body.bookId);
    assert.ok(saved.deletedAt, '重播不得清除 deleted_at');
    assert.equal(saved.revision, 2, '重播不得再推進 revision');
    assert.equal(changeRows(db, alice.id, 'vocabularyBook').length, before);
});

test('刪除頁書後以新 requestId 建立全新空白頁書，舊墓碑不復活', async (t) => {
    const { env, db, alice } = setup(t);
    const page = await createBook(env, alice, { requestId: 'page-1', name: '本頁', kind: 'page', sourceUrl: PAGE });
    assert.equal((await deleteBook(env, alice, page.body.bookId, 1)).status, 200);
    const rebuilt = await createBook(env, alice, { requestId: 'page-2', name: '重建本頁', kind: 'page', sourceUrl: PAGE });
    assert.equal(rebuilt.status, 200);
    assert.equal(rebuilt.body.created, true);
    assert.notEqual(rebuilt.body.bookId, page.body.bookId);
    assert.equal(bookRow(db, alice.id, rebuilt.body.bookId).name, '重建本頁');
    // 墓碑檢查在 ledger 之後：同一個 requestId 換 kind 會先撞上回執指紋（409）。
    const reuseId = await createBook(env, alice, { requestId: 'page-1', name: '重建本頁', kind: 'custom' });
    assert.equal(reuseId.status, 409);
    assert.equal(reuseId.body.code, 'capture_request_mismatch');
    const fresh = await createBook(env, alice, { requestId: 'fresh-custom', name: '改用自訂', kind: 'custom' });
    assert.equal(fresh.status, 200, '換新 requestId 的 custom 仍可建立');
    assert.notEqual(bookRow(db, alice.id, page.body.bookId).deletedAt, '');
});

test('並行兩個 requestId 建同一頁書：同一本、只建一列、只推進一格游標', async (t) => {
    const { env, db, alice } = setup(t);
    const results = await Promise.all([
        createBook(env, alice, { requestId: 'page-a', name: '命名 A', kind: 'page', sourceUrl: PAGE }),
        createBook(env, alice, { requestId: 'page-b', name: '命名 B', kind: 'page', sourceUrl: PAGE })
    ]);
    assert.ok(results.every((result) => result.status === 200), JSON.stringify(results));
    assert.equal(results[0].body.bookId, results[1].body.bookId);
    assert.deepEqual(results.map((result) => result.body.created).sort(), [false, true], '恰好一個請求真的建立書');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reading_entities WHERE owner_user_id=? AND entity_type='vocabularyBook'").get(alice.id).n, 1);
    assert.equal(changeRows(db, alice.id, 'vocabularyBook').length, 1);
    const state = db.prepare('SELECT next_seq FROM reading_state WHERE owner_user_id=?').get(alice.id);
    assert.equal(Number(state.next_seq), 2, '並行沿用不得重複推進游標');
    assert.equal(receiptCount(db, alice.id), 2, '兩個 requestId 各自留下回執');
});

test('並行相同 requestId 相同 payload：兩次都成功且回執一致', async (t) => {
    const { env, db, alice } = setup(t);
    const body = { requestId: 'page-1', name: '本頁', kind: 'page', sourceUrl: PAGE, makeDefault: true };
    const [a, b] = await Promise.all([createBook(env, alice, body), createBook(env, alice, body)]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.deepEqual(a.body, b.body);
    assert.equal(receiptCount(db, alice.id), 1);
    assert.equal(changeRows(db, alice.id, 'vocabularyBook').length, 1);
});

test('並行「一個要求預設、一個不要求」時預設仍指向同一本頁書', async (t) => {
    const { env, db, alice } = setup(t);
    const [withDefault, withoutDefault] = await Promise.all([
        createBook(env, alice, { requestId: 'page-a', name: 'A', kind: 'page', sourceUrl: PAGE, makeDefault: true }),
        createBook(env, alice, { requestId: 'page-b', name: 'B', kind: 'page', sourceUrl: PAGE })
    ]);
    assert.equal(withDefault.status, 200);
    assert.equal(withoutDefault.status, 200);
    assert.equal(settingsRow(db, alice.id).default_book_id, withDefault.body.bookId);
    assert.equal((await listBooks(env, alice, PAGE)).body.defaultBookId, withDefault.body.bookId);
});

// ── 5. 輸入驗證 ────────────────────────────────────────────────────────────

test('名稱與 requestId 的長度、字元在寫入前就被拒絕', async (t) => {
    const { env, db, alice } = setup(t);
    const invalid = [
        { requestId: 'r1', name: '' },
        { requestId: 'r1', name: '   ' },
        { requestId: 'r1', name: 'a'.repeat(301) },
        { requestId: '', name: '書名' },
        { requestId: 'bad/id', name: '書名' },
        { requestId: 'a'.repeat(101), name: '書名' },
        { requestId: '頁面-1', name: '書名' },
        { requestId: 'r1', name: '書名', kind: 'page' }
    ];
    for (const body of invalid) {
        const result = await createBook(env, alice, body);
        assert.equal(result.status, 400, `${JSON.stringify(body)} 應為 400`);
        assert.equal(result.body.code, 'capture_invalid_input');
    }
    const ok = await createBook(env, alice, { requestId: 'a'.repeat(100), name: 'a'.repeat(300) });
    assert.equal(ok.status, 200, '邊界值仍應接受');
    assert.equal(receiptCount(db, alice.id), 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reading_entities WHERE entity_type='vocabularyBook'").get().n, 1);
});

test('非法網址與過長網址被拒絕，不會產生沒有頁面身份的書', async (t) => {
    const { env, db, alice } = setup(t);
    const bad = [
        'javascript:alert(1)',
        'https://user:pass@news.example/story/42',
        'file:///tmp/page.html',
        'ftp://news.example/story/42',
        'not a url',
        ' ',
        `/relative/path`,
        `https://news.example/${'a'.repeat(2100)}`
    ];
    for (const [index, sourceUrl] of bad.entries()) {
        for (const kind of ['page', 'custom']) {
            const result = await createBook(env, alice, { requestId: `bad-${index}-${kind}`, name: '書名', kind, sourceUrl });
            assert.equal(result.status, 400, `${kind} + ${sourceUrl.slice(0, 40)} 應為 400`);
            assert.equal(result.body.code, 'capture_invalid_input');
        }
    }
    assert.equal(receiptCount(db, alice.id), 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reading_entities WHERE entity_type='vocabularyBook'").get().n, 0);
});

test('PUT /vocabulary/default 驗證 bookId 格式與存在性', async (t) => {
    const { env, db, alice } = setup(t);
    const book = await createBook(env, alice, { requestId: 'c-1', name: '書', kind: 'custom' });
    for (const bookId of ['', '   ', 'a'.repeat(161), 'bad id', '-leading', '$']) {
        const result = await setDefault(env, alice, bookId);
        assert.equal(result.status, 400, `${JSON.stringify(bookId)} 應為 400`);
        assert.equal(result.body.code, 'capture_invalid_input');
    }
    assert.equal((await setDefault(env, alice, 'missing-book')).status, 404);
    assert.equal(settingsRow(db, alice.id), null, '失敗的設定不得留下預設列');
    assert.equal((await setDefault(env, alice, book.body.bookId)).status, 200);
});

test('未知 kind 被當成 custom（現況：不做嚴格枚舉檢查）', async (t) => {
    const { env, db, alice } = setup(t);
    const result = await createBook(env, alice, { requestId: 'odd-kind', name: '奇怪種類', kind: 'bogus' });
    assert.equal(result.status, 200);
    assert.equal(result.body.created, true);
    assert.equal(bookRow(db, alice.id, result.body.bookId).sourceUrl, '');
    const listed = await listBooks(env, alice, PAGE);
    assert.equal(listed.body.pageBookId, '', '沒有網址的書不得被當成本頁書');
});

test('方法不符時回 405，不會寫入任何資料', async (t) => {
    const { env, db, alice } = setup(t);
    assert.equal((await request(env, '/vocabulary/books', { method: 'PUT', token: alice.token, body: {} })).status, 405);
    assert.equal((await request(env, '/vocabulary/books', { method: 'DELETE', token: alice.token, body: {} })).status, 405);
    assert.equal((await request(env, '/vocabulary/books', { method: 'PATCH', token: alice.token, body: {} })).status, 405);
    assert.equal((await request(env, '/vocabulary/default', { method: 'POST', token: alice.token, body: {} })).status, 405);
    assert.equal(receiptCount(db, alice.id), 0);
});

test('GET /vocabulary/default 回 405：方法判斷必須早於讀 body', async (t) => {
    const { env, alice } = setup(t);
    const response = await request(env, '/vocabulary/default', { method: 'GET', token: alice.token });
    assert.equal(response.status, 405, '無 body 的 GET 若先 readJsonBody 會誤報 400 bad_json；方法不符必須先回 405');
    assert.equal(response.body.code, 'method_not_allowed');
});

// ── 6. 閱讀游標 ────────────────────────────────────────────────────────────

test('舊帳戶完成遷移（legacy_write_blocked）後仍可建立詞書', async (t) => {
    const { env, db, alice } = setup(t);
    const migrated = await request(env, '/reading/mutations', { method: 'POST', token: alice.token, body: { mutations: [], final: true } });
    assert.equal(migrated.status, 200, JSON.stringify(migrated));
    assert.equal(migrated.body.legacyWriteBlocked, true);
    const page = await createBook(env, alice, { requestId: 'page-1', name: '本頁', kind: 'page', sourceUrl: PAGE, makeDefault: true });
    assert.equal(page.status, 200, JSON.stringify(page));
    assert.equal(page.body.created, true);
    const changes = await request(env, '/reading/changes?cursor=0', { token: alice.token });
    assert.deepEqual(changes.body.changes.map((change) => change.entityId), [page.body.bookId]);
    assert.equal((await capture(env, alice, { requestId: 'cap-1', bookId: page.body.bookId })).status, 200);
});

test('建書推進一格游標並出現在 /reading/changes；設定預設不推進游標', async (t) => {
    const { env, db, alice } = setup(t);
    const page = await createBook(env, alice, { requestId: 'page-1', name: '本頁', kind: 'page', sourceUrl: PAGE, makeDefault: true });
    const state = db.prepare('SELECT next_seq FROM reading_state WHERE owner_user_id=?').get(alice.id);
    assert.equal(Number(state.next_seq), 2);
    const changes = await request(env, '/reading/changes?cursor=0', { token: alice.token });
    assert.equal(changes.status, 200);
    assert.deepEqual(
        changes.body.changes.map((change) => ({ entityType: change.entityType, entityId: change.entityId, op: change.op, revision: change.revision })),
        [{ entityType: 'vocabularyBook', entityId: page.body.bookId, op: 'upsert', revision: 1 }]
    );
    const other = await createBook(env, alice, { requestId: 'custom-1', name: '另一本', kind: 'custom' });
    const before = Number(db.prepare('SELECT next_seq FROM reading_state WHERE owner_user_id=?').get(alice.id).next_seq);
    assert.equal((await setDefault(env, alice, other.body.bookId)).status, 200);
    assert.equal(Number(db.prepare('SELECT next_seq FROM reading_state WHERE owner_user_id=?').get(alice.id).next_seq), before, '設定預設不得推進閱讀游標');
    assert.equal(changeRows(db, alice.id, 'vocabularyBook').length, 2);
});

test('建書交易失敗時不留下書、回執與游標進展，修正後可重試', async (t) => {
    const { env, db, alice } = setup(t);
    db.exec("CREATE TRIGGER deny_book_change BEFORE INSERT ON reading_changes BEGIN SELECT RAISE(ABORT,'test rollback'); END");
    const failed = await createBook(env, alice, { requestId: 'page-1', name: '本頁', kind: 'page', sourceUrl: PAGE, makeDefault: true });
    assert.equal(failed.status, 500, JSON.stringify(failed));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reading_entities WHERE entity_type='vocabularyBook'").get().n, 0);
    assert.equal(receiptCount(db, alice.id), 0);
    assert.equal(settingsRow(db, alice.id), null);
    db.exec('DROP TRIGGER deny_book_change');
    const retry = await createBook(env, alice, { requestId: 'page-1', name: '本頁', kind: 'page', sourceUrl: PAGE, makeDefault: true });
    assert.equal(retry.status, 200, JSON.stringify(retry));
    assert.equal(retry.body.created, true);
    assert.equal(changeRows(db, alice.id, 'vocabularyBook').length, 1);
});

// ── 7. 文章關聯 ────────────────────────────────────────────────────────────

test('先文後書：新書建立時用既有文章補上 articleId', async (t) => {
    const { env, db, alice } = setup(t);
    const article = await createArticle(env, alice, { id: 'art_page_1', title: '頁面標題', sourceUrl: PAGE });
    assert.equal(article.status, 201, JSON.stringify(article));
    const page = await createBook(env, alice, { requestId: 'page-1', name: '本頁', kind: 'page', sourceUrl: PAGE_WITH_FRAGMENT });
    assert.equal(page.status, 200);
    const saved = bookRow(db, alice.id, page.body.bookId);
    assert.equal(saved.sourceType, 'article');
    assert.equal(saved.articleId, 'art_page_1');
    assert.equal(saved.name, '本頁');
    const listed = await listBooks(env, alice, PAGE);
    assert.equal(listed.body.articleId, 'art_page_1');
    assert.equal(listed.body.books[0].articleId, 'art_page_1');
    assert.equal(listed.body.pageBookId, page.body.bookId);
});

test('尚未建書時，查本頁也要回傳既有文章（擴充套件據此避免重複匯入）', async (t) => {
    const { env, alice } = setup(t);
    const created = await createArticle(env, alice, { id: 'art_page_1', title: '頁面標題', sourceUrl: PAGE });
    assert.equal(created.status, 201);
    const listed = await listBooks(env, alice, PAGE);
    assert.deepEqual(listed.body.books, []);
    assert.equal(listed.body.pageBookId, '');
    assert.equal(listed.body.articleId, 'art_page_1', '頁文章與詞書無關，沒有書時仍要回報');
});

test('舊版網址文章（url: 公開 ID）關聯時應使用公開 ID，而不是產生的儲存 ID', async (t) => {
    const { env, db, alice } = setup(t);
    const publicId = 'url:https%3A%2F%2Fnews.example%2Fstory%2F42%3Fedition%3Dhk';
    const imported = await request(env, '/articles/import', {
        method: 'POST',
        token: alice.token,
        body: { articles: [{ legacyId: publicId, title: '舊文章', body: '舊正文', sourceType: 'url', sourceUrl: PAGE }] }
    });
    assert.equal(imported.status, 200, JSON.stringify(imported));
    assert.equal(imported.body.imported, 1);
    const listed = await request(env, '/articles', { token: alice.token });
    const article = listed.body.changes.find((change) => change.id === publicId);
    assert.ok(article, '匯入後文章以 url: 公開 ID 對外');
    const page = await createBook(env, alice, { requestId: 'page-1', name: '本頁', kind: 'page', sourceUrl: PAGE });
    const saved = bookRow(db, alice.id, page.body.bookId);
    assert.equal(saved.articleId, publicId,
        '詞書 articleId 必須是對外的公開 ID（shared/article-protocol.mjs：舊 ID 是詞書等的關聯外鍵，儲存 ID 不可取代公開身份）');
    assert.notEqual(saved.articleId, article.storageId);
    assert.equal((await listBooks(env, alice, PAGE)).body.articleId, publicId);
});

test('先書後文：文章建立成功後應回填頁書的 articleId', async (t) => {
    const { env, db, alice } = setup(t);
    const page = await createBook(env, alice, { requestId: 'page-1', name: '本頁', kind: 'page', sourceUrl: PAGE });
    const article = await createArticle(env, alice, { id: 'art_page_1', title: '頁面標題', sourceUrl: PAGE_WITH_FRAGMENT });
    assert.equal(article.status, 201);
    const saved = bookRow(db, alice.id, page.body.bookId);
    assert.equal(saved.articleId, 'art_page_1', 'POST /articles 成功後必須回填頁書 articleId（普通片段不影響比對）');
    assert.equal(saved.sourceType, 'article');
    const listed = await listBooks(env, alice, PAGE);
    assert.equal(listed.body.pageBookId, page.body.bookId);
    assert.equal(listed.body.articleId, 'art_page_1');
});

test('文章更新（PUT）帶上新網址時也應回填頁書 articleId', async (t) => {
    const { env, db, alice } = setup(t);
    const page = await createBook(env, alice, { requestId: 'page-1', name: '本頁', kind: 'page', sourceUrl: PAGE });
    const created = await createArticle(env, alice, { id: 'art_paste_1', sourceType: 'paste', title: '貼上文章' });
    assert.equal(created.status, 201);
    const updated = await request(env, '/articles/art_paste_1', {
        method: 'PUT',
        token: alice.token,
        body: { expectedRevision: 1, sourceUrl: PAGE, sourceType: 'url' }
    });
    assert.equal(updated.status, 200, JSON.stringify(updated));
    const saved = bookRow(db, alice.id, page.body.bookId);
    assert.equal(saved.articleId, 'art_paste_1', 'PUT /articles/:id 成功後必須回填頁書 articleId');
    assert.equal(saved.sourceType, 'article');
});

test('PUT 衝突（revision 不符）不觸發關聯', async (t) => {
    const { env, db, alice } = setup(t);
    const page = await createBook(env, alice, { requestId: 'page-1', name: '本頁', kind: 'page', sourceUrl: PAGE });
    const created = await createArticle(env, alice, { id: 'art_paste_1', sourceType: 'paste', title: '貼上文章' });
    assert.equal(created.status, 201);
    const conflict = await request(env, '/articles/art_paste_1', {
        method: 'PUT',
        token: alice.token,
        body: { expectedRevision: 9, sourceUrl: PAGE, sourceType: 'url' }
    });
    assert.equal(conflict.status, 409);
    const saved = bookRow(db, alice.id, page.body.bookId);
    assert.equal(saved.articleId, undefined, '失敗的更新不得留下關聯');
    assert.equal(saved.revision, 1);
});

test('linkPageVocabularyBooks 本身正確：補關聯、保留原書資料、不碰其他帳戶', async (t) => {
    const { env, db, alice, bob } = setup(t);
    const article = await createArticle(env, alice, { id: 'art_page_1', title: '頁面標題', sourceUrl: PAGE });
    await createArticle(env, alice, { id: 'art_old', title: '保留的既有文章', sourceUrl: OTHER_PAGE });
    assert.equal(article.status, 201);
    seed(db, alice.id, 'vocabularyBook', 'legacy-book', { name: '舊頁書', sourceUrl: PAGE, note: '保留我' }, 4);
    seed(db, alice.id, 'vocabularyEntry', 'legacy-entry', { bookId: 'legacy-book', word: 'plunge', meaning: '暴跌', sources: [] }, 2);
    seed(db, alice.id, 'vocabularyBook', 'linked-book', { name: '已連結', sourceUrl: PAGE, sourceType: 'article', articleId: 'art_old' }, 3);
    seed(db, bob.id, 'vocabularyBook', 'bob-book', { name: 'Bob 書', sourceUrl: PAGE }, 1);
    // 有效文章先建立、詞書後種入，讓這次補關聯由函式本身完成。
    await linkPageVocabularyBooks(env, alice.id, { id: article.body.article.id, sourceUrl: PAGE });

    const legacy = bookRow(db, alice.id, 'legacy-book');
    assert.equal(legacy.articleId, 'art_page_1');
    assert.equal(legacy.sourceType, 'article');
    assert.equal(legacy.name, '舊頁書', '關聯不得改動書名');
    assert.equal(legacy.note, '保留我', '關聯不得丟掉既有欄位');
    assert.equal(legacy.revision, 5, '關聯應只推進一格 revision');
    const entry = db.prepare("SELECT data_json, revision FROM reading_entities WHERE owner_user_id=? AND entity_type='vocabularyEntry' AND entity_id='legacy-entry'").get(alice.id);
    assert.equal(JSON.parse(entry.data_json).meaning, '暴跌', '關聯不得改動詞條');
    assert.equal(Number(entry.revision), 2);
    const linked = bookRow(db, alice.id, 'linked-book');
    assert.equal(linked.articleId, 'art_old', '已有 articleId 的書不得被覆寫');
    assert.equal(linked.revision, 3);
    const bobBook = bookRow(db, bob.id, 'bob-book');
    assert.equal(bobBook.articleId, undefined, '不得關聯其他帳戶的書');
    assert.equal(bobBook.revision, 1);
    assert.deepEqual(changeRows(db, alice.id, 'vocabularyBook').map((row) => [row.entity_id, Number(row.revision)]), [['legacy-book', 5]]);
});

test('不同網址不誤聯：頁書與文章各自獨立', async (t) => {
    const { env, db, alice } = setup(t);
    const page = await createBook(env, alice, { requestId: 'page-1', name: '本頁', kind: 'page', sourceUrl: PAGE });
    const article = await createArticle(env, alice, { id: 'art_other', title: '別頁文章', sourceUrl: OTHER_PAGE });
    assert.equal(article.status, 201);
    // 關聯由 POST /articles 自身的掛鉤觸發；不同網址不得互相沾染。
    const saved = bookRow(db, alice.id, page.body.bookId);
    assert.equal(saved.articleId, undefined);
    assert.equal(saved.revision, 1);
    const listed = await listBooks(env, alice, PAGE);
    assert.equal(listed.body.articleId, '', '查詢本頁時不得回傳別頁文章');
    assert.equal(listed.body.books[0].articleId, '');
});

test('已刪除的文章不再被關聯（新書建立時不挑選墓碑）', async (t) => {
    const { env, db, alice } = setup(t);
    const article = await createArticle(env, alice, { id: 'art_page_1', title: '頁面標題', sourceUrl: PAGE });
    assert.equal(article.status, 201);
    const removed = await request(env, '/articles/art_page_1', { method: 'DELETE', token: alice.token, body: { expectedRevision: 1 } });
    assert.equal(removed.status, 200, JSON.stringify(removed));
    const page = await createBook(env, alice, { requestId: 'page-1', name: '本頁', kind: 'page', sourceUrl: PAGE });
    assert.equal(page.status, 200);
    const saved = bookRow(db, alice.id, page.body.bookId);
    assert.equal(saved.articleId, undefined, '文章已刪除時不得建立關聯');
    const listed = await listBooks(env, alice, PAGE);
    assert.equal(listed.body.articleId, '');
    assert.equal(listed.body.books[0].articleId, '');
});

test('文章刪除後已關聯的書：清單 articleId 為空，但書本身仍留著舊 articleId（現況不一致）', async (t) => {
    const { env, db, alice } = setup(t);
    const article = await createArticle(env, alice, { id: 'art_page_1', title: '頁面標題', sourceUrl: PAGE });
    const page = await createBook(env, alice, { requestId: 'page-1', name: '本頁', kind: 'page', sourceUrl: PAGE });
    assert.equal(page.status, 200);
    assert.equal(bookRow(db, alice.id, page.body.bookId).articleId, 'art_page_1', '先文後書應在本書建立時就關聯');
    const removed = await request(env, '/articles/art_page_1', { method: 'DELETE', token: alice.token, body: { expectedRevision: 1 } });
    assert.equal(removed.status, 200);
    const listed = await listBooks(env, alice, PAGE);
    assert.equal(listed.body.articleId, '');
    assert.equal(listed.body.books[0].articleId, 'art_page_1', '現況：書上的 articleId 不會隨文章刪除清除');
});

test('文章重試（冪等 replay）不重複回填、不重複推進書的 revision', async (t) => {
    const { env, db, alice } = setup(t);
    const page = await createBook(env, alice, { requestId: 'page-1', name: '本頁', kind: 'page', sourceUrl: PAGE });
    const created = await createArticle(env, alice, { id: 'art_page_1', title: '頁面標題', sourceUrl: PAGE, mutationId: 'mut-1' });
    assert.equal(created.status, 201);
    const afterFirst = bookRow(db, alice.id, page.body.bookId);
    assert.equal(afterFirst.articleId, 'art_page_1');
    assert.equal(afterFirst.revision, 2);
    const replay = await createArticle(env, alice, { id: 'art_page_1', title: '頁面標題', sourceUrl: PAGE, mutationId: 'mut-1' });
    assert.equal(replay.status, 200, JSON.stringify(replay));
    assert.equal(replay.body.idempotent, true);
    const afterReplay = bookRow(db, alice.id, page.body.bookId);
    assert.equal(afterReplay.articleId, 'art_page_1');
    assert.equal(afterReplay.revision, 2, '重播不得再次推進書的 revision');
    assert.equal(changeRows(db, alice.id, 'vocabularyBook').length, 2, '建書一次 + 關聯一次');
});

test('並行兩篇同網址文章只會讓頁書關聯一次、revision 只加一格', async (t) => {
    const { env, db, alice } = setup(t);
    const page = await createBook(env, alice, { requestId: 'page-1', name: '本頁', kind: 'page', sourceUrl: PAGE });
    const results = await Promise.all([
        createArticle(env, alice, { id: 'art_a', title: 'A', sourceUrl: PAGE }),
        createArticle(env, alice, { id: 'art_b', title: 'B', sourceUrl: PAGE })
    ]);
    assert.deepEqual(results.map((result) => result.status), [201, 201]);
    const saved = bookRow(db, alice.id, page.body.bookId);
    assert.ok(['art_a', 'art_b'].includes(saved.articleId), '必須關聯到其中一篇');
    assert.equal(saved.revision, 2, '兩次關聯競態只能推進一格');
    const bookChanges = changeRows(db, alice.id, 'vocabularyBook');
    assert.equal(bookChanges.length, 2, '建書一次 + 關聯一次');
    assert.deepEqual(bookChanges.map((row) => Number(row.revision)), [1, 2]);
});

test('文章復原會補回本頁詞書關聯', async (t) => {
    const { env, db, alice } = setup(t);
    const created = await createArticle(env, alice, { id: 'art_page_1', title: '頁面標題', sourceUrl: PAGE });
    assert.equal(created.status, 201);
    const removed = await request(env, '/articles/art_page_1', { method: 'DELETE', token: alice.token, body: { expectedRevision: 1 } });
    assert.equal(removed.status, 200);
    const page = await createBook(env, alice, { requestId: 'page-1', name: '本頁', kind: 'page', sourceUrl: PAGE });
    assert.equal(bookRow(db, alice.id, page.body.bookId).articleId, undefined);
    const restored = await request(env, '/articles/art_page_1/restore', { method: 'POST', token: alice.token, body: { expectedRevision: 2 } });
    assert.equal(restored.status, 200, JSON.stringify(restored));
    const saved = bookRow(db, alice.id, page.body.bookId);
    assert.equal(saved.articleId, 'art_page_1', '明確復原文章後補回頁書關聯');
    assert.equal((await listBooks(env, alice, PAGE)).body.articleId, 'art_page_1', '但清單已能查到復原後的文章');
});

test('同一網址多本頁書都會補關聯，已連結的書保持原文章', async (t) => {
    const { env, db, alice } = setup(t);
    seed(db, alice.id, 'vocabularyBook', 'book-a', { name: 'A', sourceUrl: PAGE }, 2);
    seed(db, alice.id, 'vocabularyBook', 'book-b', { name: 'B', sourceUrl: PAGE_WITH_FRAGMENT }, 7);
    seed(db, alice.id, 'vocabularyBook', 'book-c', { name: 'C', sourceUrl: OTHER_PAGE }, 1);
    const article = await createArticle(env, alice, { id: 'art_page_1', title: '頁面標題', sourceUrl: PAGE });
    assert.equal(article.status, 201);
    assert.equal(bookRow(db, alice.id, 'book-a').articleId, 'art_page_1');
    assert.equal(bookRow(db, alice.id, 'book-a').revision, 3);
    assert.equal(bookRow(db, alice.id, 'book-b').articleId, 'art_page_1');
    assert.equal(bookRow(db, alice.id, 'book-b').revision, 8);
    assert.equal(bookRow(db, alice.id, 'book-c').articleId, undefined, '不同網址的書不得被關聯');
    assert.equal(bookRow(db, alice.id, 'book-c').revision, 1);
});

test('我建立文章不會關聯他人同網址的頁書', async (t) => {
    const { env, db, alice, bob } = setup(t);
    seed(db, bob.id, 'vocabularyBook', 'bob-page', { name: 'Bob 頁書', sourceUrl: PAGE }, 1);
    const article = await createArticle(env, alice, { id: 'art_page_1', title: '頁面標題', sourceUrl: PAGE });
    assert.equal(article.status, 201);
    const bobBook = bookRow(db, bob.id, 'bob-page');
    assert.equal(bobBook.articleId, undefined, '關聯只能發生在文章擁有者自己的書');
    assert.equal(bobBook.revision, 1);
    assert.equal(changeRows(db, bob.id).length, 0, '不得替他人帳戶寫入變更紀錄');
});

test('hash 路由的頁書只被同路由的文章關聯', async (t) => {
    const { env, db, alice } = setup(t);
    const lesson1 = await createBook(env, alice, { requestId: 'l1', name: '第 1 課', kind: 'page', sourceUrl: 'https://app.example/#/lesson/1' });
    const lesson2 = await createBook(env, alice, { requestId: 'l2', name: '第 2 課', kind: 'page', sourceUrl: 'https://app.example/#/lesson/2' });
    const article = await createArticle(env, alice, { id: 'art_lesson_1', title: '第 1 課文章', sourceUrl: 'https://app.example/#/lesson/1' });
    assert.equal(article.status, 201);
    assert.equal(bookRow(db, alice.id, lesson1.body.bookId).articleId, 'art_lesson_1');
    assert.equal(bookRow(db, alice.id, lesson2.body.bookId).articleId, undefined, '不同 hash 路由不得被同一篇文章關聯');
    assert.equal((await listBooks(env, alice, 'https://app.example/#/lesson/1')).body.articleId, 'art_lesson_1');
    assert.equal((await listBooks(env, alice, 'https://app.example/#/lesson/2')).body.articleId, '');
});

test('關聯失敗時應回 JSON 500，不得讓 worker.fetch 直接 reject', async (t) => {
    const { env, db, alice } = setup(t);
    await createBook(env, alice, { requestId: 'page-1', name: '本頁', kind: 'page', sourceUrl: PAGE });
    db.exec("CREATE TRIGGER deny_link BEFORE INSERT ON reading_changes WHEN NEW.entity_type='vocabularyBook' BEGIN SELECT RAISE(ABORT,'test link failure'); END");
    const settled = await createArticle(env, alice, { id: 'art_page_1', title: '頁面標題', sourceUrl: PAGE, mutationId: 'mut-1' })
        .then((response) => ({ rejected: false, response }), (error) => ({ rejected: true, error }));
    assert.equal(settled.rejected, false,
        `worker.fetch 直接 reject（${settled.rejected ? settled.error.message : ''}）：worker.js 在 try 內 return handleArticlesRoute(...) 卻沒有 await，async 例外接不住`);
    assert.equal(settled.response.status, 500);
    assert.equal(settled.response.body.code, 'internal_error', '失敗回應必須仍是 JSON 錯誤封套');
});

test('關聯失敗不留半套資料，修正後同 clientMutationId 重試可補回關聯', async (t) => {
    const { env, db, alice } = setup(t);
    const page = await createBook(env, alice, { requestId: 'page-1', name: '本頁', kind: 'page', sourceUrl: PAGE });
    db.exec("CREATE TRIGGER deny_link BEFORE INSERT ON reading_changes WHEN NEW.entity_type='vocabularyBook' BEGIN SELECT RAISE(ABORT,'test link failure'); END");
    const failed = await createArticle(env, alice, { id: 'art_page_1', title: '頁面標題', sourceUrl: PAGE, mutationId: 'mut-1' })
        .catch((error) => ({ status: 0, body: { code: error.code || error.message } }));
    assert.ok(!failed || failed.status === 500 || failed.status === 0, '關聯失敗不應回成功');
    assert.ok(db.prepare("SELECT id FROM articles WHERE owner_user_id=? AND id='art_page_1'").get(alice.id), '文章交易已提交');
    const saved = bookRow(db, alice.id, page.body.bookId);
    assert.equal(saved.articleId, undefined, '關聯失敗不得留下半套書資料');
    assert.equal(saved.revision, 1);
    assert.equal(changeRows(db, alice.id, 'vocabularyBook').length, 1, '只有建書那一次變更');
    db.exec('DROP TRIGGER deny_link');
    const retry = await createArticle(env, alice, { id: 'art_page_1', title: '頁面標題', sourceUrl: PAGE, mutationId: 'mut-1' });
    assert.equal(retry.status, 200, JSON.stringify(retry));
    assert.equal(retry.body.idempotent, true);
    assert.equal(bookRow(db, alice.id, page.body.bookId).articleId, 'art_page_1', '同 clientMutationId 重試應補回關聯');
    assert.equal(changeRows(db, alice.id, 'vocabularyBook').length, 2);
});

// ── 8. 來源 hash 路由 ──────────────────────────────────────────────────────

test('hash 路由必須保留區分：不同 #/ 路由是不同頁書', async (t) => {
    const { env, db, alice } = setup(t);
    const a = await createBook(env, alice, { requestId: 'route-a', name: '第 1 課', kind: 'page', sourceUrl: 'https://app.example/#/lesson/1' });
    const b = await createBook(env, alice, { requestId: 'route-b', name: '第 2 課', kind: 'page', sourceUrl: 'https://app.example/#/lesson/2' });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.notEqual(a.body.bookId, b.body.bookId, '不同 hash 路由不得合併成同一本頁書');
    assert.equal(a.body.created, true);
    assert.equal(b.body.created, true);
    assert.equal(bookIds((await listBooks(env, alice, 'https://app.example/#/lesson/1')).body).length, 2);
    assert.equal((await listBooks(env, alice, 'https://app.example/#/lesson/1')).body.pageBookId, a.body.bookId);
    assert.equal((await listBooks(env, alice, 'https://app.example/#/lesson/2')).body.pageBookId, b.body.bookId);
    assert.equal(changeRows(db, alice.id, 'vocabularyBook').length, 2);
});

test('hash 路由與普通片段：#! 保留、#section 忽略', async (t) => {
    const { env, alice } = setup(t);
    const bang = await createBook(env, alice, { requestId: 'bang-1', name: '驚嘆號', kind: 'page', sourceUrl: 'https://app.example/read#!/chapter/1' });
    const bangOther = await createBook(env, alice, { requestId: 'bang-2', name: '驚嘆號2', kind: 'page', sourceUrl: 'https://app.example/read#!/chapter/2' });
    assert.notEqual(bang.body.bookId, bangOther.body.bookId, '#! 路由必須保留區分');
    const plain = await createBook(env, alice, { requestId: 'plain-1', name: '片段', kind: 'page', sourceUrl: 'https://news.example/story/42?edition=hk#comments' });
    const same = await createBook(env, alice, { requestId: 'plain-2', name: '片段2', kind: 'page', sourceUrl: PAGE });
    assert.equal(same.body.bookId, plain.body.bookId, '普通片段不得產生另一本頁書');
    assert.equal(same.body.created, false);
    const other = await createBook(env, alice, { requestId: 'query-1', name: '參數順序', kind: 'page', sourceUrl: 'https://news.example/story/42?edition=hk&page=2' });
    assert.notEqual(other.body.bookId, plain.body.bookId, '不同查詢字串是不同頁');
});

// ── 9. 清單與來源網址的一致性 ──────────────────────────────────────────────

test('非法 sourceUrl 查詢不得把無網址的書當成本頁書', async (t) => {
    const { env, alice } = setup(t);
    const custom = await createBook(env, alice, { requestId: 'custom-1', name: '一般詞書', kind: 'custom' });
    for (const sourceUrl of ['not a url', 'javascript:alert(1)', ' /relative', 'https://user:pass@news.example/story/42']) {
        const listed = await listBooks(env, alice, sourceUrl);
        assert.equal(listed.status, 200);
        assert.equal(listed.body.pageBookId, '', `來源網址 ${sourceUrl} 不是有效頁面，不得預選任何頁書`);
        assert.equal(listed.body.articleId, '');
        assert.deepEqual(listed.body.books.map((book) => book.id), [custom.body.bookId], '無效網址仍可列出本人書');
    }
});
