/**
 * 靜態稽核：locale 鍵集合一致性、程式碼中引用但字典缺少的鍵、
 * 以及 JS 動態字串中殘留的硬編碼中文。
 *
 * 用法：node tests/audit-i18n.mjs [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const zhCN = (await import(path.join(ROOT, 'locales/zh-CN.js'))).default;
const zhHK = (await import(path.join(ROOT, 'locales/zh-HK.js'))).default;

function flatten(obj, prefix = '', out = new Map()) {
    for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
        else out.set(key, v);
    }
    return out;
}

const cn = flatten(zhCN);
const hk = flatten(zhHK);

const onlyCN = [...cn.keys()].filter(k => !hk.has(k));
const onlyHK = [...hk.keys()].filter(k => !cn.has(k));

// 插值參數一致性
const paramsMismatch = [];
const paramNames = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
for (const [k, v] of cn) {
    if (!hk.has(k)) continue;
    const a = paramNames(v), b = paramNames(hk.get(k));
    if (a !== b) paramsMismatch.push({ key: k, cn: a, hk: b });
}

// ---- 掃描原始碼引用的鍵 ----
const SRC_DIRS = ['features', 'modules', 'locales'];
const files = [];
(function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|mjs|html)$/.test(entry.name)) files.push(full);
    }
})(ROOT);
for (const extra of ['index.html', 'phonetics.html', 'test-floating-statusbar.html']) {
    const p = path.join(ROOT, extra);
    if (fs.existsSync(p)) files.push(p);
}

const referenced = new Map(); // key -> [file:line]
const addRef = (key, file, line) => {
    if (!key) return;
    const list = referenced.get(key) || [];
    list.push(`${path.relative(ROOT, file)}:${line}`);
    referenced.set(key, list);
};

const HARDCODED = []; // 疑似硬編碼中文

for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n');
    const isLocale = file.includes(`${path.sep}locales${path.sep}`);
    // 稽核腳本自身含用來比對鍵名的正則字面值，會產生假陽性
    const isAuditTool = path.relative(ROOT, file).startsWith(`tests${path.sep}`);

    lines.forEach((line, i) => {
        if (isLocale || isAuditTool) return;
        const lineNo = i + 1;
        // t('a.b') / t("a.b")
        for (const m of line.matchAll(/\bt\(\s*['"`]([\w.-]+)['"`]/g)) addRef(m[1], file, lineNo);
        // data-i18n="a.b" 系列
        for (const m of line.matchAll(/data-i18n(?:-title|-placeholder|-aria-label|-value)?="([\w.-]+)"/g)) {
            addRef(m[1], file, lineNo);
        }
        // i18n 取鍵的間接寫法：getTranslation('a.b') / translate('a.b')
        for (const m of line.matchAll(/\b(?:getTranslation|translate|i18nKey)\(\s*['"`]([\w.-]+)['"`]/g)) {
            addRef(m[1], file, lineNo);
        }
    });
}

const missingKeys = [];
for (const [key, locs] of referenced) {
    if (!cn.has(key) && !hk.has(key)) missingKeys.push({ key, refs: locs.slice(0, 3) });
    else if (!hk.has(key)) missingKeys.push({ key, refs: locs.slice(0, 3), note: 'zh-HK 缺少' });
    else if (!cn.has(key)) missingKeys.push({ key, refs: locs.slice(0, 3), note: 'zh-CN 缺少' });
}

// JS 檔案中被單引號／雙引號包住、且含有中日韓字元的字面值（排除註解）
const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/;
for (const file of files) {
    if (file.includes(`${path.sep}locales${path.sep}`)) continue;
    if (file.endsWith('.html')) continue; // 靜態 HTML 由 data-i18n 覆蓋，另案檢查
    const rel = path.relative(ROOT, file);
    if (rel.startsWith('modules' + path.sep + 'prompts')) continue; // 提示詞本來就是中文
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
        // 去掉行尾註解
        const noComment = line.replace(/\/\/.*$/, '');
        const matches = [...noComment.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)];
        for (const m of matches) {
            const val = m[2];
            if (!CJK.test(val)) continue;
            if (/^[\s\u4e00-\u9fff\u3400-\u4dbf，。！？、；：（）「」『』…—·]+$/.test(val) === false) continue;
            HARDCODED.push({ file: rel, line: i + 1, text: val.slice(0, 60) });
        }
    });
}


// ---- HTML 標籤內直接寫死中文（label/h4/strong/span/p/button…）----
// 這類文案常混在模板字串裡，逐行掃描會因為字串跨行而整批漏掉，
// 必須對整個檔案內容做匹配。（實際踩過：單詞本引導彈窗的正文是硬編碼繁體，
// 在簡體介面下顯示錯誤，舊版掃描器完全沒報。）
const HTML_LABEL_HITS = [];
{
    const TAG = /<(label|h4|h5|h6|strong|span|p|th|td|summary|option|button)\b[^>]*>\s*([^<>{}]*[\u4e00-\u9fff][^<>{}]*?)\s*<\//g;
    for (const file of files) {
        if (!file.endsWith('.js')) continue;   // .html 的中文是 data-i18n 的回退文案，屬既定寫法
        const rel = path.relative(ROOT, file);
        if (rel.startsWith('locales' + path.sep) || rel.startsWith('modules' + path.sep + 'prompts')) continue;
        if (rel === 'ai-config.js' || rel === 'ai-config.example.js') continue;
        const src = fs.readFileSync(file, 'utf8');
        const byLine = src.split('\n');
        let m;
        while ((m = TAG.exec(src)) !== null) {
            const line = src.slice(0, m.index).split('\n').length;
            const srcLine = byLine[line - 1] || '';
            if (/^\s*(\/\/|\*)/.test(srcLine)) continue;   // 註解行
            if (/console\./.test(srcLine)) continue;
            HTML_LABEL_HITS.push({ file: rel, line, tag: m[1], text: m[2].trim().slice(0, 50) });
        }
    }
}

// 未使用的鍵（僅提示）
const unused = [...cn.keys()].filter(k => !referenced.has(k));

const report = {
    localeCounts: { 'zh-CN': cn.size, 'zh-HK': hk.size },
    onlyInZhCN: onlyCN,
    onlyInZhHK: onlyHK,
    interpolationMismatch: paramsMismatch,
    missingKeys,
    hardcodedChinese: HARDCODED,
    hardcodedHtmlLabels: HTML_LABEL_HITS,
    unusedKeyCount: unused.length,
    unusedKeys: unused
};

if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
} else {
    console.log('=== locale 鍵數 ===', report.localeCounts);
    console.log('\n=== 僅存在於 zh-CN 的鍵 (%d) ===', onlyCN.length);
    onlyCN.forEach(k => console.log('  -', k));
    console.log('\n=== 僅存在於 zh-HK 的鍵 (%d) ===', onlyHK.length);
    onlyHK.forEach(k => console.log('  -', k));
    console.log('\n=== 插值參數不一致 (%d) ===', paramsMismatch.length);
    paramsMismatch.forEach(p => console.log(`  - ${p.key}: CN{${p.cn}} HK{${p.hk}}`));
    console.log('\n=== 引用但缺少的鍵 (%d) ===', missingKeys.length);
    missingKeys.forEach(m => console.log(`  - ${m.key} ${m.note || ''} <- ${m.refs.join(', ')}`));
    console.log('\n=== JS 中疑似硬編碼中文 (%d) ===', HARDCODED.length);
    HARDCODED.slice(0, 200).forEach(h => console.log(`  - ${h.file}:${h.line}  ${h.text}`));
    console.log('\n=== HTML 標籤內直接寫死中文 (%d) ===', HTML_LABEL_HITS.length);
    HTML_LABEL_HITS.forEach(h => console.log(`  - ${h.file}:${h.line}  <${h.tag}> ${h.text}`));
    console.log('\n=== 未被引用鍵數 ===', unused.length);
}
