#!/usr/bin/env node
// Pre-deploy guard: the static frontend must not ship any default AI provider
// URL, model mapping or shared API key.
//
// Usage:
//   node scripts/check-ai-static-config.mjs                 # check ./ai-config.js and root HTML
//   node scripts/check-ai-static-config.mjs --dir ../dist   # check the actual publish directory
//   node scripts/check-ai-static-config.mjs --dir . --deep  # scan every served text file
//   node scripts/check-ai-static-config.mjs --json
//   ( set -o pipefail; curl -fsS https://<site>/ai-config.js \
//     | node scripts/check-ai-static-config.mjs --stdin --name ai-config.js )
//   ... --dir -            # same as --stdin (also accepts --dir /dev/stdin)
//
// Exit codes:
//   0  a real scan ran and produced no finding
//   1  a finding was reported
//   2  the scan itself failed — missing/unreadable target, a target that is
//      not a directory, empty stdin, no file scanned, or a readdir/read error.
//      Exit 2 is never "clean": an uninspected input must not look safe.
//
// Findings contain file names, line numbers and the *kind* of the problem only
// — never the matched value, so the output is safe to paste into a ticket or a
// log.
//
// What "clean" means here:
//   - `ai-config.js` may keep TTS / SYNC.endpoint / limits / article fetch and
//     QA-OCR parameters; it must not export API_URL, API_KEY, AI_PROVIDERS,
//     AI_PROFILES, AI_TASKS, AI_MODELS or AI_PROMPTS.
//   - No served file may contain an `apiKey`-style literal that looks like a
//     real key, an `Authorization: Bearer <literal>` or a provider key prefix.
//
// This is a static text check, not a secret scanner and not a substitute for
// revoking the old shared keys at the provider console.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function argValue(name, fallback) {
    const index = process.argv.indexOf(name);
    if (index === -1 || index === process.argv.length - 1) return fallback;
    return process.argv[index + 1];
}

// `-` and the fd-0 aliases mean "scan what is piped in", never "scan a
// directory by that name". Without an explicit input there is nothing to check,
// so these must be handled before any path resolution.
const STDIN_ALIASES = new Set(['-', '/dev/stdin', '/dev/fd/0']);
const rawDir = argValue('--dir', ROOT);
const useStdin = process.argv.includes('--stdin') || STDIN_ALIASES.has(String(rawDir));
const stdinName = String(argValue('--name', 'ai-config.js')).trim() || 'ai-config.js';
const deep = process.argv.includes('--deep');
const asJson = process.argv.includes('--json');
const targetDir = useStdin ? '' : path.resolve(process.cwd(), rawDir);
const displayDir = useStdin ? '<stdin>' : targetDir;

const SKIP_DIRS = new Set(['.git', 'node_modules', 'docs', 'cloudflare-worker', 'tests', 'scripts']);
const TEXT_EXT = /\.(js|mjs|cjs|json|html|css|txt)$/i;

const LEGACY_AI_EXPORTS = [
    'API_URL',
    'API_KEY',
    'AI_PROVIDERS',
    'AI_PROFILES',
    'AI_TASKS',
    'AI_MODELS',
    'AI_PROMPTS'
];

const findings = [];
const scanErrors = [];
let scannedFiles = 0;

function addFinding(label, line, kind) {
    findings.push({ file: label, line, kind });
}

// Keep URL strings intact: splitting at the first // also truncates https://.
// This is a line-oriented check, not a full JavaScript parser.
function withoutLineComment(raw) {
    let quote = '';
    for (let i = 0; i < raw.length; i += 1) {
        const char = raw[i];
        if (quote) {
            if (char === '\\') i += 1;
            else if (char === quote) quote = '';
        } else if (char === '"' || char === "'" || char === '`') {
            quote = char;
        } else if (char === '/' && raw[i + 1] === '/') {
            return raw.slice(0, i);
        }
    }
    return raw;
}

function scanText(label, text) {
    const lines = String(text).split('\n');
    const basename = path.basename(String(label).replace(/^<stdin>/i, ''));
    const isAiConfig = basename === 'ai-config.js' || basename === 'ai-config.example.js';
    lines.forEach((raw, index) => {
        const lineNumber = index + 1;
        const line = withoutLineComment(raw);
        if (!line.trim()) return;
        if (isAiConfig) {
            for (const name of LEGACY_AI_EXPORTS) {
                const exported = new RegExp(`export\\s+(?:const|let|var)\\s+${name}\\b`).test(line)
                    || new RegExp(`^\\s*${name}\\s*:`).test(line);
                if (exported) addFinding(label, lineNumber, `legacy-ai-export:${name}`);
            }
        }
        // An `apiKey:` / `API_KEY =` assignment with a value long enough to be a
        // real credential. Only the kind is reported, never the value.
        if (/(api[_-]?key|apiKey)\s*[:=]\s*['"`][A-Za-z0-9_\-./+=]{12,}['"`]/.test(line)) {
            addFinding(label, lineNumber, 'inline-api-key-literal');
        }
        if (/Authorization\s*['"`]?\s*[:=]\s*['"`]Bearer\s+[A-Za-z0-9_\-.]{12,}/.test(line)) {
            addFinding(label, lineNumber, 'inline-bearer-token');
        }
        if (/\b(sk-[A-Za-z0-9]{16,}|sk-ant-[A-Za-z0-9_\-]{16,}|AIza[0-9A-Za-z_\-]{30,})\b/.test(line)) {
            addFinding(label, lineNumber, 'provider-key-prefix');
        }
        // Hostname hints used to recognise a user-entered URL are not static
        // defaults. Flag concrete provider URLs, including protocol-relative
        // URLs, while allowing host-only protocol detection tables/comparisons.
        if (!isAiConfig && /(?:https?:)?\/\/(api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com)(?=[:/\s'"`?#]|$)/i.test(line)) {
            addFinding(label, lineNumber, 'hardcoded-provider-endpoint');
        }
    });
}

function walk(dir, depth = 0) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
        // A directory we could not list must fail the check: silently skipping
        // it would report "clean" for content nobody looked at.
        scanErrors.push({ path: path.relative(targetDir, dir) || '.', code: 'readdir_failed' });
        return;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!deep) continue;
            if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
            walk(full, depth + 1);
            continue;
        }
        if (!entry.isFile()) continue;
        if (!deep) {
            const atRoot = dir === targetDir;
            if (!atRoot && depth === 0) continue;
            if (!/^ai-config(\.example)?\.js$/.test(entry.name) && !(atRoot && /\.html$/i.test(entry.name))) continue;
        } else if (!TEXT_EXT.test(entry.name)) continue;
        let text = '';
        try {
            text = fs.readFileSync(full, 'utf8');
        } catch (error) {
            scanErrors.push({ path: path.relative(targetDir, full) || entry.name, code: 'read_failed' });
            continue;
        }
        scannedFiles += 1;
        scanText(path.relative(targetDir, full) || entry.name, text);
    }
}

function emit(report) {
    if (asJson) {
        console.log(JSON.stringify(report, null, 2));
        return;
    }
    if (report.error) {
        console.error(`檢查失敗（${report.error}）：${report.message}`);
        console.error('未完成掃描不可以當作通過。');
    } else {
        const where = report.dir === '<stdin>' ? '檢查 stdin' : `檢查目錄：${report.dir}`;
        console.log(`${where}${report.deep ? '（深度掃描）' : ''}`);
    }
    if (report.findings.length) {
        for (const item of report.findings) {
            // Deliberately no matched text: only file, line and kind.
            console.log(`- ${item.file}:${item.line} ${item.kind}`);
        }
        console.log(`共 ${report.findings.length} 項；請先完成靜態設定遷移，不要直接發布。`);
    } else if (!report.error) {
        console.log(`已檢查 ${report.scanned} 個檔案，沒有發現靜態 AI 供應商網址、模型映射或金鑰。`);
    }
    if (report.scanErrors.length) {
        for (const item of report.scanErrors) {
            console.error(`- ${item.path}: ${item.code}`);
        }
    }
}

function buildReport(extra = {}) {
    return {
        dir: displayDir,
        deep,
        scanned: scannedFiles,
        findings,
        scanErrors,
        ok: false,
        ...extra
    };
}

/** Abort with exit 2: the input was never inspected, so it is not "clean". */
function fail(code, message) {
    const report = buildReport({ ok: false, error: code, message });
    emit(report);
    process.exit(2);
}

function main() {
    if (useStdin) {
        if (process.stdin.isTTY) {
            fail('stdin_missing', '需要從 stdin 管道輸入內容，或以 --dir <目錄> 指定要檢查的目錄');
        }
        let text = '';
        try {
            text = fs.readFileSync(0, 'utf8');
        } catch (error) {
            fail('stdin_read_failed', '無法讀取 stdin');
        }
        if (!String(text).trim()) {
            fail('stdin_empty', 'stdin 沒有內容（可能是下載失敗或空回應），不可以當作通過');
        }
        scannedFiles = 1;
        scanText(stdinName, text);
        const ok = findings.length === 0;
        const report = buildReport({ ok });
        emit(report);
        if (!ok) process.exitCode = 1;
        return;
    }

    let stat;
    try {
        stat = fs.statSync(targetDir);
    } catch (error) {
        fail('target_missing', `目錄不存在：${targetDir}`);
    }
    if (!stat.isDirectory()) {
        fail('target_not_directory', `不是目錄：${targetDir}（若要在管道模式檢查內容，請用 --stdin 或 --dir -）`);
    }
    try {
        fs.readdirSync(targetDir);
    } catch (error) {
        fail('target_unreadable', `無法讀取目錄：${targetDir}`);
    }

    walk(targetDir);

    if (scanErrors.length) {
        const report = buildReport({ ok: false, error: 'scan_failed', message: '掃描期間有檔案或目錄無法讀取' });
        emit(report);
        process.exit(2);
    }
    if (scannedFiles === 0) {
        // Nothing matched the filter: this is not evidence that the build is
        // free of static AI settings.
        fail('no_files_scanned', `目錄中沒有符合檢查條件的檔案：${targetDir}`);
    }

    const ok = findings.length === 0;
    const report = buildReport({ ok });
    emit(report);
    if (!ok) process.exitCode = 1;
}

main();
