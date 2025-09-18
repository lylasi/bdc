#!/usr/bin/env node
// Generate a CJK+ASCII character set from project sources for font subsetting.
// Output: modules/fonts/subset-chars.txt
// Usage: node scripts/gen-subset-chars.js [extraTextFile]

const fs = require('fs');
const path = require('path');

function walk(dir, exts, list = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.venv') continue;
      walk(p, exts, list);
    } else if (exts.includes(path.extname(entry.name))) {
      list.push(p);
    }
  }
  return list;
}

const files = [
  ...walk('.', ['.js', '.html', '.css']),
];

let text = '';
for (const f of files) {
  try { text += fs.readFileSync(f, 'utf8'); } catch (_) {}
}

// Seed with common UI phrases to ensure coverage (Traditional + Simplified)
const seed = (
  '手寫默寫練習日期姓名成績說明答案第頁共生成時間問答訓練結果報告問答集名稱訓練時間訓練時長訓練模式隨機模式順序模式題目總數已回答訓練總結準確率平均得分完全正確完成率詳細答案分析問題標準答案您的答案未回答評分點評' +
  '说明成绩练习手写默写生成时间问答训练结果报告问答集名称训练时间训练时长训练模式随机模式顺序模式题目总数已回答训练总结准确率平均得分完全正确完成率详细答案分析问题标准答案您的答案未回答评分点评' +
  '中文繁體簡體英文' // labels
);

text += seed;

// Allow extra text file specified by argv
if (process.argv[2] && fs.existsSync(process.argv[2])) {
  text += fs.readFileSync(process.argv[2], 'utf8');
}

// Collect CJK + fullwidth punctuation; also include ASCII printable
const cjk = new Set(Array.from(text).filter(ch => /[\u3000-\u303F\u31C0-\u31EF\u3400-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch)));
const ascii = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";

const final = Array.from(new Set([...ascii, ...cjk])).join('');

fs.mkdirSync('modules/fonts', { recursive: true });
fs.writeFileSync('modules/fonts/subset-chars.txt', final, 'utf8');

console.log(`subset-chars written: ${final.length} chars -> modules/fonts/subset-chars.txt`);
