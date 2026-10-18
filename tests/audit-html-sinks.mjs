/**
 * 靜態掃描：HTML 拼接上下文中的未轉義插值
 *
 * 目的：`el.innerHTML = `<div>${data}</div>`` 這種寫法只要 `data` 來自使用者、
 * 匯入檔、遠端 manifest 或 localStorage，就是一個注入點。這個掃描器把
 * 「含有 HTML 標籤的樣板字串」裡的插值全部列出來，並標記
 *  - SAFE     已用 escapeHtml / escapeAttr / tHtml 包住
 *  - REVIEW   看起來像資料欄位（name / word / title / keyword …）而沒有轉義
 *  - LOW      其餘插值（多半是數字、長度、HTML 片段）
 *
 * 產出的是「候選清單」，不是確定漏洞；REVIEW 項需要人工複核資料來源。
 *
 * 用法：
 *   node tests/audit-html-sinks.mjs                 # 摘要
 *   node tests/audit-html-sinks.mjs --list=review   # 列出所有 REVIEW 項
 *   node tests/audit-html-sinks.mjs --json out.json # 輸出 JSON
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const listMode = (args.find((a) => a.startsWith('--list=')) || '').split('=')[1] || '';
const jsonOut = (args.find((a) => a.startsWith('--json=')) || '').split('=')[1] || '';

// 看起來是「資料」的欄位名：沒有轉義就要人工複核
const DATA_HINT = /\b(name|word|words|meaning|phonetic|title|description|desc|question|answer|keyword|url|uri|path|text|content|label|value|message|markdown|note|remark|tag|category|chapter|author|thumbnail|source|filename|bookName|setName)\b/;
const SAFE_CALL = /\b(escapeHtml|escapeAttr|tHtml)\s*\(/;
const SAFE_EXPR = /^(\s*(?:Number|String|Boolean)\s*\(|[^A-Za-z_$]*$)/;

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'vendor' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

/** 找出檔案中所有樣板字串，回傳 { text, exprs: [{ expr, line }] } */
function templateLiterals(src, file) {
    const out = [];
    let i = 0;
    const lineOf = (idx) => src.slice(0, idx).split('\n').length;
    while (i < src.length) {
        if (src[i] !== '`') { i += 1; continue; }
        const start = i;
        i += 1;
        const exprs = [];
        let depth = 0;
        let buf = '';
        let text = '';
        while (i < src.length) {
            const ch = src[i];
            if (ch === '\\') { text += src.slice(i, i + 2); i += 2; continue; }
            if (depth === 0 && ch === '`') { i += 1; break; }
            if (ch === '$' && src[i + 1] === '{') {
                depth += 1; i += 2;
                let exprStart = i;
                let nest = 1;
                while (i < src.length && nest > 0) {
                    if (src[i] === '{') nest += 1;
                    else if (src[i] === '}') { nest -= 1; if (nest === 0) break; }
                    else if (src[i] === '`') { // 巢狀樣板：整段跳過
                        i += 1;
                        while (i < src.length && src[i] !== '`') { if (src[i] === '\\') i += 1; i += 1; }
                    }
                    i += 1;
                }
                exprs.push({ expr: src.slice(exprStart, i).trim(), line: lineOf(exprStart) });
                text += ' ';
                i += 1;
                continue;
            }
            text += ch;
            i += 1;
        }
        out.push({ text, exprs, line: lineOf(start), file });
    }
    return out;
}

const files = [
    ...walk(path.join(ROOT, 'features')),
    ...walk(path.join(ROOT, 'modules')),
    path.join(ROOT, 'main.js')
];

const buckets = { SAFE: [], REVIEW: [], LOW: [] };
for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const tpl of templateLiterals(src, file)) {
        if (!/<[a-zA-Z!/]/.test(tpl.text)) continue;   // 沒有 HTML 標籤，不是 HTML 上下文
        for (const { expr, line } of tpl.exprs) {
            const rec = { file: path.relative(ROOT, file), line, expr: expr.replace(/\s+/g, ' ').slice(0, 160) };
            if (SAFE_CALL.test(expr) || SAFE_EXPR.test(expr)) buckets.SAFE.push(rec);
            else if (DATA_HINT.test(expr)) buckets.REVIEW.push(rec);
            else buckets.LOW.push(rec);
        }
    }
}

console.log(`掃描 ${files.length} 個模組，含 HTML 標籤的樣板字串插值：`);
console.log(`  SAFE（已轉義）   : ${buckets.SAFE.length}`);
console.log(`  REVIEW（待複核） : ${buckets.REVIEW.length}`);
console.log(`  LOW（其他）      : ${buckets.LOW.length}`);

if (listMode === 'review' || listMode === 'all') {
    console.log('\n=== REVIEW ===');
    for (const r of buckets.REVIEW) console.log(`${r.file}:${r.line}  ${r.expr}`);
}
if (listMode === 'all') {
    console.log('\n=== LOW ===');
    for (const r of buckets.LOW) console.log(`${r.file}:${r.line}  ${r.expr}`);
}
if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify(buckets, null, 2));
    console.log(`\n-> ${jsonOut}`);
}
