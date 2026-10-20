#!/usr/bin/env node
/**
 * 產生 index.html 的靜態資源版本（import map）。
 *
 * 背景：正式站由 Cloudflare 快取靜態檔案。只替 main.js 加 ?v= 不夠，
 * main.js 內部的相對 import 仍會拿到快取中的舊模組。這裡從 main.js
 * 遞迴解析所有本機 ES Module（含 .mjs、locales、動態 import），把它們
 * 全部映射到同一個 release query，讓一次頁面載入只會使用同一個版本。
 *
 * 用法：
 *   node scripts/update-release-map.mjs            # 更新 index.html
 *   node scripts/update-release-map.mjs --check    # 只檢查是否為最新（部署前用）
 *
 * 規則：
 * - release 由模組內容與 styles.css 內容雜湊產生，任一檔案變更即換版本。
 * - ai-config.js 是執行期私人設定，刻意不版本化、不納入雜湊。
 * - 不處理 vendors／字型等以傳統 script 載入的資產；它們不是 ES Module。
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML_FILE = 'index.html';
const ENTRY_MODULE = 'main.js';
const STYLE_FILE = 'styles.css';
const AI_CONFIG = 'ai-config.js';
const MAP_START = '<!-- release-assets:importmap:start -->';
const MAP_END = '<!-- release-assets:importmap:end -->';

function absolute(relativePath) {
    return path.join(ROOT, ...relativePath.split('/'));
}

function moduleSpecifiers(source) {
    const specifiers = [];
    // 靜態 import／export ... from 與字面量動態 import('...')。
    const pattern = /\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    let match;
    while ((match = pattern.exec(source)) !== null) {
        const specifier = match[1] || match[2];
        if (specifier) specifiers.push(specifier);
    }
    return specifiers;
}

/**
 * 從 main.js 遞迴收集本機 ES Module。
 * 非相對路徑（例如 esm.sh）由瀏覽器自行處理，不在 import map 範圍。
 */
async function collectModules() {
    const modules = new Set();
    const queue = [ENTRY_MODULE];
    while (queue.length) {
        const relativePath = queue.shift();
        if (relativePath === AI_CONFIG || modules.has(relativePath)) continue;
        if (!/\.(?:m?js)$/.test(relativePath)) continue;
        if (!existsSync(absolute(relativePath))) {
            throw new Error(`找不到模組：${relativePath}`);
        }
        modules.add(relativePath);
        const source = await readFile(absolute(relativePath), 'utf8');
        for (const specifier of moduleSpecifiers(source)) {
            if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue;
            if (specifier.includes('?') || specifier.includes('#')) {
                throw new Error(`${relativePath} 的 import 已含 query/hash，無法套用統一版本：${specifier}`);
            }
            const target = path.posix.normalize(
                path.posix.join(path.posix.dirname(relativePath), specifier)
            );
            queue.push(target);
        }
    }
    return [...modules].sort();
}

async function releaseOf(modules) {
    const hash = createHash('sha256');
    for (const relativePath of modules) {
        hash.update(relativePath);
        hash.update('\0');
        hash.update(await readFile(absolute(relativePath)));
        hash.update('\0');
    }
    hash.update(STYLE_FILE);
    hash.update('\0');
    hash.update(await readFile(absolute(STYLE_FILE)));
    return hash.digest('hex').slice(0, 12);
}

function renderMap(modules, release, indent) {
    const imports = {};
    for (const relativePath of modules) {
        imports[`/${relativePath}`] = `/${relativePath}?v=${release}`;
    }
    const lines = [
        MAP_START,
        '<!-- 由 scripts/update-release-map.mjs 產生；請勿手改，改完模組或 CSS 後重新執行。 -->',
        '<script type="importmap">',
        ...JSON.stringify({ imports }, null, 2).split('\n').map((line) => `  ${line}`),
        '</script>',
        MAP_END
    ];
    return lines.map((line) => `${indent}${line}`).join('\n');
}

function applyToHtml(html, modules, release) {
    const rendered = renderMap(modules, release, '    ');
    let next = html;
    const start = next.indexOf(MAP_START);
    if (start !== -1) {
        const end = next.indexOf(MAP_END, start);
        if (end === -1) throw new Error('index.html 的 import map 結束標記缺失');
        // 連同標記所在整行一起換掉，避免每次執行都多一層縮排。
        const startLine = next.lastIndexOf('\n', start) + 1;
        const endLineBreak = next.indexOf('\n', end + MAP_END.length);
        const endLine = endLineBreak === -1 ? next.length : endLineBreak;
        next = next.slice(0, startLine) + rendered + next.slice(endLine);
    } else {
        const anchor = '    <link rel="stylesheet" href="styles.css';
        const anchorIndex = next.indexOf(anchor);
        if (anchorIndex === -1) throw new Error('找不到 styles.css 插入位置');
        next = next.slice(0, anchorIndex) + rendered + '\n' + next.slice(anchorIndex);
    }

    next = next.replace(
        /(<link\s+rel="stylesheet"\s+href=")styles\.css(?:\?[^"]*)?(")/,
        `$1${STYLE_FILE}?v=${release}$2`
    );
    next = next.replace(
        /(<script\s+type="module"\s+src=")main\.js(?:\?[^"]*)?(")/,
        `$1${ENTRY_MODULE}?v=${release}$2`
    );
    return next;
}

const checkOnly = process.argv.includes('--check');
const modules = await collectModules();
const release = await releaseOf(modules);
const html = await readFile(absolute(HTML_FILE), 'utf8');
const next = applyToHtml(html, modules, release);

if (checkOnly) {
    if (next !== html) {
        console.error(`index.html 的 release import map 不是最新（應為 ${release}）。`);
        console.error('請執行：node scripts/update-release-map.mjs');
        process.exitCode = 1;
    } else {
        console.log(`release import map 已是最新：${release}（${modules.length} 個模組）`);
    }
} else if (next !== html) {
    await writeFile(absolute(HTML_FILE), next);
    console.log(`已更新 index.html：${release}（${modules.length} 個模組、含 styles.css／main.js）`);
} else {
    console.log(`index.html 無需更新：${release}（${modules.length} 個模組）`);
}
