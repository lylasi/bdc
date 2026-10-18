#!/usr/bin/env node
// One-time migration helper for the legacy static AI configuration.
//
// What it does
//   1. Reads the local `ai-config.js` (never prints secret values).
//   2. Writes a private JSON export OUTSIDE the web root:
//        ../bdc-ai-config-import-<timestamp>.json   (mode 0600)
//      containing the legacy providers, keys, models and task mappings. An admin
//      can import this file explicitly from "Manage default providers".
//   3. Replaces `ai-config.js` with a sanitised version that keeps only non-AI
//      settings (TTS, sync endpoint, limits, article fetch service, QA/OCR knobs).
//   4. Keeps a private backup of the original outside the web root (mode 0600).
//
// Usage:
//   node scripts/migrate-ai-config.mjs --dry-run
//   node scripts/migrate-ai-config.mjs
//
// IMPORTANT: after migrating, revoke/rotate the old shared keys at the provider
// console. Removing the file cannot revoke keys already copied by browsers.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(ROOT, 'ai-config.js');
const dryRun = process.argv.includes('--dry-run');

function timestamp() {
    const d = new Date();
    const pad = (n, len = 2) => String(n).padStart(len, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(d.getMilliseconds(), 3)}`;
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
}

function stripConnectionFields(record) {
    if (!isPlainObject(record)) return record;
    const out = clone(record);
    for (const key of ['PROFILE', 'API_URL', 'API_KEY', 'MODEL', 'MODELS', 'DEFAULT_MODEL']) {
        delete out[key];
    }
    return out;
}

function writeStateFile(target, content, mode = 0o600) {
    if (dryRun) return;
    fs.writeFileSync(target, content, { mode });
    try { fs.chmodSync(target, mode); } catch (_) {}
}

async function loadLegacyConfig(source) {
    // `ai-config.js` is ESM but lives in a directory without "type": "module".
    // Evaluate it as a data: module so Node treats it as ESM.
    const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
    return await import(dataUrl);
}

function inferFormat(provider) {
    const apiUrl = String(provider.apiUrl || provider.API_URL || '');
    if (/\/messages$/i.test(apiUrl)) return 'anthropic-messages';
    if (/:generateContent/i.test(apiUrl) || /generativelanguage\.googleapis\.com/i.test(apiUrl)) return 'gemini';
    return 'openai-chat';
}

function deriveEndpoints(format, baseUrl, apiUrl, modelsUrl) {
    let base = String(baseUrl || '').replace(/\/+$/, '');
    let api = String(apiUrl || '').trim();
    let models = String(modelsUrl || '').trim();
    if (!api && base) {
        if (format === 'anthropic-messages') {
            const stem = /\/v\d+[a-z0-9-]*$/i.test(base) ? base : `${base}/v1`;
            api = `${stem}/messages`;
            models = models || `${stem}/models`;
        } else if (format === 'gemini') {
            const stem = /\/v\d+(?:beta|alpha)?\d*$/i.test(base) ? base : `${base}/v1beta`;
            api = `${stem}/models/%7Bmodel%7D:generateContent`;
            models = models || `${stem}/models`;
        } else {
            const stem = /\/v\d+[a-z0-9-]*$/i.test(base) ? base : `${base}/v1`;
            api = `${stem}/chat/completions`;
            models = models || `${stem}/models`;
        }
    }
    if (!base && api) {
        const stripped = api.replace(/\/(?:chat\/completions|messages)$/i, '');
        base = /\/models\//.test(stripped) ? stripped.split('/models/')[0] : stripped;
        if (!models) {
            if (format === 'gemini') models = `${base}/models`;
            else models = `${stripped}/models`;
        }
    }
    return { baseUrl: base, apiUrl: api, modelsUrl: models };
}

function extractLegacy(mod) {
    const providers = isPlainObject(mod.AI_PROVIDERS)
        ? mod.AI_PROVIDERS
        : (isPlainObject(mod.AI_PROFILES) ? mod.AI_PROFILES : {});
    const tasks = isPlainObject(mod.AI_TASKS) ? mod.AI_TASKS : (isPlainObject(mod.AI_MODELS) ? mod.AI_MODELS : {});
    const rows = [];
    const defaultProvider = {
        id: 'default',
        label: 'default',
        baseUrl: '',
        apiUrl: mod.API_URL || '',
        modelsUrl: '',
        apiKey: mod.API_KEY || '',
        allowedModels: [],
        discoveredModels: []
    };
    const ids = new Set(['default', ...Object.keys(providers)]);
    for (const id of ids) {
        const raw = id === 'default' ? (providers.default || {}) : (providers[id] || {});
        const apiUrl = raw.apiUrl || raw.API_URL || (id === 'default' ? mod.API_URL : '') || '';
        const baseUrl = raw.baseUrl || raw.BASE_URL || '';
        const modelsUrl = raw.modelsUrl || raw.MODELS_URL || '';
        const format = inferFormat({ apiUrl });
        const endpoints = deriveEndpoints(format, baseUrl, apiUrl, modelsUrl);
        const allowedModels = Array.isArray(raw.allowedModels)
            ? raw.allowedModels
            : (Array.isArray(raw.MODELS) ? raw.MODELS : []);
        rows.push({
            sourceId: id,
            label: String(raw.label || raw.name || (id === 'default' ? 'default' : id)),
            format,
            baseUrl: endpoints.baseUrl,
            apiUrl: endpoints.apiUrl,
            modelsUrl: endpoints.modelsUrl,
            apiKey: String(raw.apiKey || raw.API_KEY || (id === 'default' ? mod.API_KEY : '') || ''),
            allowedModels: allowedModels.map((value) => {
                const text = String(value || '').trim();
                return text.startsWith(`${id}:`) ? text.slice(id.length + 1) : text;
            }).filter(Boolean)
        });
    }
    return { providers: rows, tasks };
}

async function main() {
    if (!fs.existsSync(CONFIG)) {
        console.error('找不到 ai-config.js，無需遷移。');
        process.exit(1);
    }
    const source = fs.readFileSync(CONFIG, 'utf8');
    let mod;
    try {
        mod = await loadLegacyConfig(source);
    } catch (error) {
        console.error('無法解析 ai-config.js：', error && error.message ? error.message : error);
        process.exit(1);
    }
    const hasAI = !!mod.API_URL || !!mod.API_KEY
        || isPlainObject(mod.AI_PROVIDERS) || isPlainObject(mod.AI_TASKS) || isPlainObject(mod.AI_MODELS);
    if (!hasAI) {
        console.log('ai-config.js 已不含靜態 AI 供應商設定，無需遷移。');
        return;
    }

    const { providers, tasks } = extractLegacy(mod);
    const ts = timestamp();
    const exportPath = path.resolve(ROOT, '..', `bdc-ai-config-import-${ts}.json`);
    const backupPath = path.resolve(ROOT, '..', `bdc-ai-config-backup-${ts}.js`);
    const payload = {
        generatedAt: new Date().toISOString(),
        note: 'Private legacy AI export. Import through BDC → Settings → Manage default providers, then delete this file.',
        providers,
        tasks
    };

    const sanitized = `// BDC local configuration (sanitised by scripts/migrate-ai-config.mjs).
//
// Static AI provider defaults were removed. Default providers are now published
// by an admin through BDC → Settings → Manage default providers and stored in D1.
// Personal providers/keys live in the account-scoped local AI profile.
//
// Original file backed up outside the web root: ${path.basename(backupPath)}
// Private admin import file: ${path.basename(exportPath)}

export const AI_LIMITS = ${JSON.stringify(mod.AI_LIMITS || {}, null, 2)};

export const TTS_CONFIG = ${JSON.stringify(mod.TTS_CONFIG || {}, null, 2)};

export const QA_CHECK = ${JSON.stringify(stripConnectionFields(mod.QA_CHECK), null, 2)};

export const OCR_CONFIG = ${JSON.stringify(stripConnectionFields(mod.OCR_CONFIG), null, 2)};

export const ARTICLE_IMPORT = ${JSON.stringify(stripConnectionFields(mod.ARTICLE_IMPORT), null, 2)};

export const SUPABASE = ${JSON.stringify(mod.SUPABASE || {}, null, 2)};

export const SYNC = ${JSON.stringify(mod.SYNC || {}, null, 2)};

const __DEFAULT__ = {
    AI_LIMITS,
    TTS_CONFIG,
    QA_CHECK,
    OCR_CONFIG,
    ARTICLE_IMPORT,
    SUPABASE,
    SYNC
};
export default __DEFAULT__;
`;

    console.log(`偵測到 ${providers.length} 個舊供應商、${Object.keys(tasks || {}).length} 個任務映射。`);
    console.log(`私密匯入檔（僅管理員本機使用）：${exportPath}`);
    console.log(`原始設定備份：${backupPath}`);
    console.log('注意：完成匯入後，請到供應商控制台撤銷／更換舊的共享 Key。');
    if (dryRun) {
        console.log('[dry-run] 未寫入任何檔案。');
        return;
    }
    writeStateFile(exportPath, JSON.stringify(payload, null, 2));
    writeStateFile(backupPath, source);
    fs.writeFileSync(CONFIG, sanitized, 'utf8');
    console.log('已改寫 ai-config.js（只保留非 AI 設定）。');
}

main().catch((error) => {
    console.error('遷移失敗：', error && error.message ? error.message : error);
    process.exit(1);
});
