// 產生「新增 / 重新開通使用者」的 SQL（通行碼與恢復碼皆以 SHA-256 雜湊存入，不存明文）。
//
// 用法：
//   node add-user.mjs <通行碼> <user_id> [label]
//
// 範例：
//   node add-user.mjs "alice-的通行碼" alice "Alice"
// 會：
//   1) 在終端機印出「通行碼 + 恢復碼」（只顯示這一次，請轉交該使用者保存）
//   2) 印出一段 INSERT SQL，再用 wrangler 套用到遠端 D1：
//      wrangler d1 execute bdc-sync --remote --command "<印出的 SQL>"
//
// 注意：每次執行都會「重新產生恢復碼」並覆蓋舊值（等於重新開通該使用者）。
//       日常「改通行碼」請用網頁自助功能（不會更動恢復碼）。

import { createHash, randomBytes } from 'node:crypto';

const [, , token, userId, label = ''] = process.argv;
if (!token || !userId) {
  console.error('用法: node add-user.mjs <通行碼> <user_id> [label]');
  process.exit(1);
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const esc = (s) => String(s).replace(/'/g, "''");

// 恢復碼：~20 字元的隨機字串，用於「忘記通行碼」自助重置
const recovery = randomBytes(15).toString('base64url');
const tokenHash = sha256(token);
const recoveryHash = sha256(recovery);

const sql =
  `INSERT INTO users (token_hash, user_id, label, recovery_hash) ` +
  `VALUES ('${tokenHash}', '${esc(userId)}', '${esc(label)}', '${recoveryHash}') ` +
  `ON CONFLICT(user_id) DO UPDATE SET token_hash = excluded.token_hash, label = excluded.label, recovery_hash = excluded.recovery_hash;`;

console.error('============== 請保存（只顯示這一次） ==============');
console.error(`user_id : ${userId}`);
console.error(`通行碼  : ${token}`);
console.error(`恢復碼  : ${recovery}`);
console.error('==================================================');
console.error('把下面這段 SQL 套用到遠端 D1：');
console.log(sql);
