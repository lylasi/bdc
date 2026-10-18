// Generate SQL to create or re-issue a user for the self-host sync server.
// The same SQL works on SQLite and PostgreSQL.
//
// Usage:
//   node add-user.mjs <user_id> [label]
//   node add-user.mjs --admin <user_id> [label]
//   node add-user.mjs --token <passcode> <user_id> [label]
//
// Apply:
//   SQLite:     sqlite3 data/bdc-sync.sqlite < user.sql
//   PostgreSQL: psql "$DATABASE_URL" -f user.sql
//
// The passcode and recovery code are printed once to stderr; only their
// SHA-256 hashes are written to SQL.

import { createHash, randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
let role = 'user';
let explicitToken = '';
const positional = [];
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--admin') { role = 'admin'; continue; }
  if (arg === '--token') { explicitToken = String(args[i + 1] || ''); i += 1; continue; }
  if (arg === '--help' || arg === '-h') {
    console.error('用法: node add-user.mjs [--admin] [--token <passcode>] <user_id> [label]');
    process.exit(0);
  }
  positional.push(arg);
}

const [userId, label = ''] = positional;
if (!userId) {
  console.error('用法: node add-user.mjs [--admin] [--token <passcode>] <user_id> [label]');
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]{1,64}$/.test(userId)) {
  console.error('user_id 只可使用英文字母、數字、- 或 _（最多 64 字元）。');
  process.exit(1);
}

const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');
const escape = (value) => String(value).replace(/'/g, "''");

const token = explicitToken || randomBytes(32).toString('base64url');
if (token.length < 32) {
  console.error('通行碼至少需要 32 個字元（建議使用腳本自動產生的隨機值）。');
  process.exit(1);
}

const recovery = randomBytes(24).toString('base64url');
const sql =
  `INSERT INTO users (token_hash, user_id, label, recovery_hash, role) ` +
  `VALUES ('${sha256(token)}', '${escape(userId)}', '${escape(label)}', '${sha256(recovery)}', '${role}') ` +
  `ON CONFLICT(user_id) DO UPDATE SET token_hash = excluded.token_hash, label = excluded.label, recovery_hash = excluded.recovery_hash;`;

console.error('============== 請保存（只顯示這一次） ==============');
console.error(`user_id : ${userId}`);
console.error(`label   : ${label || '(空)'}`);
console.error(`role    : ${role}（既有帳戶不會被改動）`);
console.error(`通行碼  : ${token}`);
console.error(`恢復碼  : ${recovery}`);
console.error('通行碼與恢復碼只存 SHA-256 雜湊；遺失後只能再用本工具重設。');
console.error('==================================================');
console.error('把下面這段 SQL 套用到 SQLite 或 PostgreSQL：');
console.log(sql);
