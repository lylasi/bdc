// Generate JSON articles for 5A Ready Reading from a single text file.
// - Input: articles/5a_ready_reading_texts.txt (with sections separated by lines '---')
// - Output: JSON files in articles/5a ready reading/ named per manifest when available
// - Manifest: ensure entries exist (do not overwrite description/category/difficulty if already present)
//
// Notes:
// - We prefer existing IDs/titles/paths from manifest for stability.
// - If an entry for uN- is missing, we create one with a slug from the parsed title.
// - Content is the raw reading text (without the 'Reading N: ...' header), preserving paragraphs.

/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const inputPath = path.join(root, 'articles', '5a_ready_reading_texts.txt');
const outDir = path.join(root, 'articles', '5a ready reading');
const manifestPath = path.join(root, 'articles', 'manifest.json');

function slugify(s) {
    return s
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '') // remove punctuation except spaces and hyphens
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-');
}

function readTextFile(p) {
    return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}

function parseSections(raw) {
    // Split on lines that are exactly '---' (with surrounding blank lines optional)
    const parts = raw
        .split(/\n\s*---\s*\n+/g)
        .map(s => s.trim())
        .filter(Boolean);
    const sections = [];
    for (const part of parts) {
        const lines = part.split('\n');
        const header = lines.shift();
        const m = header && header.match(/^Reading\s+(\d+)\s*:\s*(.+)$/i);
        if (!m) {
            console.warn('Skip section without proper header:', header);
            continue;
        }
        const num = Number(m[1]);
        const parsedTitle = m[2].trim();
        const content = lines.join('\n').trim();
        sections.push({ num, parsedTitle, content });
    }
    return sections;
}

function ensureDir(p) {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function loadManifest() {
    if (!fs.existsSync(manifestPath)) return [];
    try {
        return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
        console.error('Failed to parse manifest.json:', e);
        return [];
    }
}

function saveManifest(list) {
    const json = JSON.stringify(list, null, 2) + '\n';
    fs.writeFileSync(manifestPath, json, 'utf8');
}

function main() {
    ensureDir(outDir);
    const raw = readTextFile(inputPath);
    const sections = parseSections(raw);
    if (!sections.length) {
        console.error('No sections parsed from', inputPath);
    process.exit(1);
    }

    const manifest = loadManifest();
    let manifestChanged = false;

    for (const { num, parsedTitle, content } of sections) {
        // Find existing manifest entry for this unit (id starts with `u<num>-`)
        const idPrefix = `u${num}-`;
        let entry = manifest.find(it => typeof it.id === 'string' && it.id.startsWith(idPrefix));

        let effectiveTitle = parsedTitle;
        let filename;
        if (entry) {
            // Use existing title/path for stability
            effectiveTitle = entry.title || parsedTitle;
            // Path expected like: articles/5a ready reading/uN-... .json
            const relPath = entry.path || `articles/5a ready reading/${idPrefix}${slugify(effectiveTitle)}.json`;
            filename = path.join(root, relPath);
        } else {
            // Create new entry
            const slug = slugify(parsedTitle || `reading-${num}`);
            const id = `${idPrefix}${slug}`;
            const relPath = `articles/5a ready reading/${id}.json`;
            entry = {
                id,
                title: parsedTitle || `Reading ${num}`,
                description: '',
                difficulty: '初級 (CEFR A2)',
                category: '',
                path: relPath
            };
            manifest.push(entry);
            manifestChanged = true;
            filename = path.join(root, relPath);
        }

        // Write JSON file
        const out = {
            title: effectiveTitle,
            content
        };
        ensureDir(path.dirname(filename));
        fs.writeFileSync(filename, JSON.stringify(out, null, 2) + '\n', 'utf8');
        console.log('Wrote', path.relative(root, filename));
    }

    if (manifestChanged) {
        saveManifest(manifest);
        console.log('Updated manifest.json');
    } else {
        console.log('Manifest unchanged');
    }
}

main();
