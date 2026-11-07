#!/usr/bin/env node
// Deterministic packager for the BDC MV3 extension directory (`extension/`).
//
// - Copies required shared modules (`modules/`, `locales/`, `shared/`) into
//   `extension/` so relative ES module imports resolve inside the extension root.
// - Generates `extension/ai-config.js` strictly from `ai-config.example.js`,
//   never reading or copying the workspace's private `ai-config.js`.
// - Verifies that every relative import inside `extension/` points to an existing
//   file inside `extension/` and no remote/CDN executable scripts are referenced.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zhCN from '../locales/zh-CN.js';
import zhHK from '../locales/zh-HK.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = path.join(ROOT, 'extension');

const SHARED_FILES = [
    'locales/zh-CN.js',
    'locales/zh-HK.js',
    'modules/ai-catalog.js',
    'modules/ai-credential-sync.js',
    'modules/ai-models.js',
    'modules/ai-profile-storage.js',
    'modules/ai-protocols/anthropic.js',
    'modules/ai-protocols/chat-completions.js',
    'modules/ai-protocols/common.js',
    'modules/ai-protocols/gemini.js',
    'modules/ai-protocols/index.js',
    'modules/ai-settings-sanitize.js',
    'modules/ai-thinking.js',
    'modules/api.js',
    'modules/audio.js',
    'modules/voices.js',
    'modules/article-store.js',
    'modules/cache.js',
    'modules/extension-ai-runtime.js',
    'modules/extension-ai-preferences.js',
    'modules/extension-assistant.js',
    'modules/extension-capture.js',
    'modules/extension-workspace.js',
    'modules/i18n-config.js',
    'modules/i18n.js',
    'modules/markdown.js',
    'modules/permanent-db.js',
    'modules/phonetics-data.js',
    'modules/prompts/article.js',
    'modules/prompts/assistant.js',
    'modules/prompts/dictation.js',
    'modules/prompts/dictionary.js',
    'modules/prompts/import.js',
    'modules/prompts/index.js',
    'modules/prompts/language-rules.js',
    'modules/prompts/learning.js',
    'modules/prompts/ocr.js',
    'modules/prompts/qa.js',
    'modules/reading-store.js',
    'modules/settings.js',
    'modules/state.js',
    'modules/storage.js',
    'modules/sync-cloudflare.js',
    'modules/sync-core.js',
    'modules/sync-signals.js',
    'modules/validate.js',
    'shared/article-protocol.mjs',
    'shared/reading-protocol.mjs',
    'shared/vocabulary-source.mjs',
    'shared/capture-protocol.mjs',
    'shared/capture-client.mjs',
    'shared/page-protocol.mjs',
    'shared/workspace-client.mjs'
];

function writeArtifact(destination, content) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.tmp-${process.pid}`;
    try {
        fs.writeFileSync(temporary, content);
        fs.renameSync(temporary, destination);
    } finally {
        fs.rmSync(temporary, { force: true });
    }
}

export function packageExtension() {
    if (!fs.existsSync(EXT_DIR)) {
        fs.mkdirSync(EXT_DIR, { recursive: true });
    }

    // 1. Generate extension/ai-config.js exclusively from ai-config.example.js
    const exampleConfigPath = path.join(ROOT, 'ai-config.example.js');
    const exampleContent = fs.readFileSync(exampleConfigPath, 'utf8');
    writeArtifact(path.join(EXT_DIR, 'ai-config.js'), exampleContent);
    for (const [locale, dictionary] of [['zh_CN', zhCN], ['zh_TW', zhHK]]) {
        writeArtifact(path.join(EXT_DIR, '_locales', locale, 'messages.json'), JSON.stringify({
            extensionName: { message: dictionary.extension.manifestTitle },
            extensionDescription: { message: dictionary.extension.manifestDescription }
        }, null, 4) + '\n');
    }

    // 2. Copy shared modules into extension/
    for (const rel of SHARED_FILES) {
        const src = path.join(ROOT, rel);
        const dest = path.join(EXT_DIR, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const content = fs.readFileSync(src);
        writeArtifact(dest, content);
        if (!fs.readFileSync(dest).equals(content)) throw new Error(`Packaged file differs from source: ${rel}`);
    }

    // 3. Verify all relative imports inside extension/
    const entryFiles = [
        'lookup.js',
        'ai-controls.js',
        'tts-controls.js',
        'capture-ui.js',
        'workspace-ui.js',
        'inline-panel.js',
        'assistant-ui.js',
        'icons.js',
        'page-extractor.js',
        'page-lookup.js',
        'background.js',
        'selection-extractor.js',
        ...SHARED_FILES
    ];
    const importRe = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
    const extRootResolved = path.resolve(EXT_DIR);

    for (const rel of entryFiles) {
        const file = path.join(EXT_DIR, rel);
        if (!fs.existsSync(file)) {
            throw new Error(`Missing packaged extension file: ${rel}`);
        }
        const content = fs.readFileSync(file, 'utf8');
        let match;
        while ((match = importRe.exec(content)) !== null) {
            const spec = match[1];
            if (/^https?:/i.test(spec)) {
                throw new Error(`Remote executable import forbidden in extension (${rel} -> ${spec})`);
            }
            if (!spec.startsWith('.')) {
                throw new Error(`Bare module import not supported in MV3 extension (${rel} -> ${spec})`);
            }
            const resolved = path.resolve(path.dirname(file), spec);
            if (!resolved.startsWith(extRootResolved + path.sep) && resolved !== extRootResolved) {
                throw new Error(`Import escapes extension root (${rel} -> ${spec})`);
            }
            if (!fs.existsSync(resolved)) {
                throw new Error(`Broken import inside extension (${rel} -> ${spec})`);
            }
        }
    }

    return {
        extensionDir: EXT_DIR,
        copiedCount: SHARED_FILES.length + 3
    };
}

let invokedAsScript = false;
try {
    invokedAsScript = !!process.argv[1]
        && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
} catch (_) {}
if (invokedAsScript) {
    const result = packageExtension();
    console.log(`Packaged ${result.copiedCount} files into ${result.extensionDir}`);
}
