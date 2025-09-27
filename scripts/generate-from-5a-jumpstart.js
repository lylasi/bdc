// Generate JSON articles for 5A Jumpstart Reading from a single text file.
// - Input: articles/5a_jumpstart_reading_articles.txt (sections separated by lines '---')
// - Output: JSON files in articles/5a jumpstart reading/
// - Manifest: append entries for each unit with category 'R&E'
//
// Notes:
// - IDs follow the pattern u{unit}-{slug} to align with existing convention.
// - Description is a short fallback based on the title; you can edit later in manifest if needed.
// - Difficulty defaults to '初級 (CEFR A2)'.

/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const inputPath = path.join(root, 'articles', '5a_jumpstart_reading_articles.txt');
const outDir = path.join(root, 'articles', '5a jumpstart reading');
const manifestPath = path.join(root, 'articles', 'manifest.json');

function slugify(s) {
  return String(s || '')
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
  // Split on lines that are exactly '---' with optional surrounding whitespace
  const parts = raw
    .split(/\n\s*---\s*\n+/g)
    .map(s => s.trim())
    .filter(Boolean);

  const sections = [];
  for (const part of parts) {
    const lines = part.split('\n');
    const header = lines.shift();
    const m = header && header.match(/^Unit\s+(\d+)\s*:\s*(.+)$/i);
    if (!m) {
      console.warn('Skip section without proper header:', header);
      continue;
    }
    const num = Number(m[1]);
    const title = m[2].trim();
    const content = lines.join('\n').trim();
    sections.push({ num, title, content });
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

  for (const { num, title, content } of sections) {
    const idPrefix = `u${num}-`;
    // Avoid colliding with existing uN- entries from other series by checking path directory
    const exists = manifest.find(it => typeof it.id === 'string' && it.id.startsWith(idPrefix) && String(it.path || '').includes('5a jumpstart reading'));

    const slug = slugify(title || `unit-${num}`);
    const id = `${idPrefix}${slug}`;
    const relPath = `articles/5a jumpstart reading/${id}.json`;

    // Write JSON article
    const out = { title, content };
    ensureDir(path.dirname(path.join(root, relPath)));
    fs.writeFileSync(path.join(root, relPath), JSON.stringify(out, null, 2) + '\n', 'utf8');
    console.log('Wrote', relPath);

    if (!exists) {
      manifest.push({
        id,
        title,
        description: `Jumpstart Reading Unit ${num}: ${title}`,
        difficulty: '初級 (CEFR A2)',
        category: 'R&E',
        path: relPath
      });
      manifestChanged = true;
    }
  }

  if (manifestChanged) {
    saveManifest(manifest);
    console.log('Updated manifest.json');
  } else {
    console.log('Manifest unchanged');
  }
}

main();

