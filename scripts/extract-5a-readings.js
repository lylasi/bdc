#!/usr/bin/env node
/**
 * Extract reading articles from the PDF→Markdown for "5a ready reading".
 *
 * Output JSON schema (same as samples):
 *   { "title": string, "content": string }
 *
 * Changes:
 * - Preserve blank lines to detect paragraphs and reflow intra‑paragraph hard breaks.
 * - Drop images and non‑reading sections (Vocabulary / Reading skill / Self-learning skill headings).
 * - Prepend the article title as the first line of content, per import requirement.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const mdPath = path.join(root, 'articles', '5a ready reading', '5a ready reading.md');
const outDir = path.join(root, 'articles', '5a ready reading');

function readFile(p) {
  return fs.readFileSync(p, 'utf8');
}

function writeJSON(p, obj) {
  const json = JSON.stringify(obj, null, 2);
  fs.writeFileSync(p, json + '\n', 'utf8');
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
}

function cleanLines(lines) {
  return lines
    .map((ln) => ln.replace(/\s*\\&\s*/g, ' & ')) // unescape \& from OCR
    .map((ln) => ln.replace(/\s{2,}/g, ' ').trim()) // normalize spaces but keep blanks as ''
    .map((ln) => (ln === '' ? '' : ln))
    .filter((ln) => !ln.startsWith('![')) // drop images
    .filter((ln) => !/^#+\s*(Vocabulary|Reading\s*skill|Self-learning\s*skill)\b/i.test(ln)) // drop section headings
    .filter((ln) => !/^\(?\d+\)?\s*$/.test(ln)); // drop lines that are only page numbers
}

function extractSliceBetween(lines, startIndex, endIndexExclusive) {
  const slice = lines.slice(startIndex, endIndexExclusive);
  return cleanLines(slice);
}

function findIndex(lines, predicate, from = 0) {
  for (let i = from; i < lines.length; i++) if (predicate(lines[i], i)) return i;
  return -1;
}

function joinParasReflow(lines) {
  // Build paragraphs separated by blank lines; join intra-paragraph lines with spaces.
  const paras = [];
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    const merged = buf.join(' ').replace(/\s+/g, ' ').trim();
    if (merged) paras.push(merged);
    buf = [];
  };
  for (const ln of lines) {
    if (!ln) {
      flush();
      continue;
    }
    buf.push(ln);
  }
  flush();
  return paras.join('\n\n');
}

function ensureFound(label, idx) {
  if (idx < 0) throw new Error(`Anchor not found: ${label}`);
}

function main() {
  const md = readFile(mdPath);
  const lines = md.split(/\r?\n/);

  const outputs = [];
  const warnings = [];

  // Unit 1: Lost in the city
  {
    const start = findIndex(lines, (ln) => /^#\s*Lost in the city\s*$/i.test(ln));
    ensureFound('Unit1 start (# Lost in the city)', start);
    const end = findIndex(lines, (ln, i) => i > start && /^#\s+/.test(ln) && !/^#\s*Lost in the city\s*$/i.test(ln));
    ensureFound('Unit1 end (next # ...)', end);
    const contentLines = extractSliceBetween(lines, start + 1, end);
    const title = 'Lost in the city';
    outputs.push({ unit: 1, title, contentLines });
  }

  // Unit 2: A tour in Hong Kong → Reading after "# Reading" until "# (2) Reading skill"
  {
    const unitHdr = findIndex(lines, (ln) => /^#\s*2\)\s*A tour in Hong Kong\s*$/i.test(ln));
    ensureFound('Unit2 header', unitHdr);
    const readingHdr = findIndex(lines, (ln, i) => i > unitHdr && /^#\s*Reading\s*$/i.test(ln));
    ensureFound('Unit2 # Reading', readingHdr);
    const skillHdr = findIndex(lines, (ln, i) => i > readingHdr && /^#\s*\(2\)\s*Reading skill\s*$/i.test(ln));
    ensureFound('Unit2 Reading skill', skillHdr);
    const contentLines = extractSliceBetween(lines, readingHdr + 1, skillHdr);
    const relStart = readingHdr + 1;
    const relEnd = skillHdr;
    const firstH2 = findIndex(lines, (ln, i) => i >= relStart && i < relEnd && /^##\s+/.test(ln));
    const title = firstH2 >= 0 ? lines[firstH2].replace(/^##\s+/, '').trim() : 'A tour in Hong Kong – Reading';
    outputs.push({ unit: 2, title, contentLines });
  }

  // Unit 3: When Grandma was young → after "# Reading" until "## (3) Reading skill"
  {
    const unitHdr = findIndex(lines, (ln) => /^#\s*3\)\s*When Grandma was young\s*$/i.test(ln));
    ensureFound('Unit3 header', unitHdr);
    const readingHdr = findIndex(lines, (ln, i) => i > unitHdr && /^#\s*Reading\s*$/i.test(ln));
    ensureFound('Unit3 # Reading', readingHdr);
    const skillHdr = findIndex(lines, (ln, i) => i > readingHdr && /^##\s*\(3\)\s*Reading skill\s*$/i.test(ln));
    ensureFound('Unit3 Reading skill', skillHdr);
    const contentLines = extractSliceBetween(lines, readingHdr + 1, skillHdr);
    const title = 'When Grandma was young';
    outputs.push({ unit: 3, title, contentLines });
  }

  // Unit 4: An offline holiday → after "# Reading" until "# (1) Reading skill"
  {
    const unitHdr = findIndex(lines, (ln) => /^#\s*4\s+An offline holiday\s*$/i.test(ln));
    ensureFound('Unit4 header', unitHdr);
    const readingHdr = findIndex(lines, (ln, i) => i > unitHdr && /^#\s*Reading\s*$/i.test(ln));
    ensureFound('Unit4 # Reading', readingHdr);
    const skillHdr = findIndex(lines, (ln, i) => i > readingHdr && /^#\s*\(1\)\s*Reading skill\s*$/i.test(ln));
    ensureFound('Unit4 Reading skill', skillHdr);
    const contentLines = extractSliceBetween(lines, readingHdr + 1, skillHdr);
    let title = 'An offline holiday';
    const relStart = readingHdr + 1;
    const relEnd = skillHdr;
    const h2Idx = findIndex(lines, (ln, i) => i >= relStart && i < relEnd && /^##\s*An offline holiday\s*$/i.test(ln));
    if (h2Idx >= 0) title = lines[h2Idx].replace(/^##\s+/, '').trim();
    outputs.push({ unit: 4, title, contentLines });
  }

  // Unit 5: A wonderful weekend → after "# Reading" until "## (3) Reading skill"
  {
    const unitHdr = findIndex(lines, (ln) => /^#\s*5\s+A wonderful weekend\s*$/i.test(ln));
    ensureFound('Unit5 header', unitHdr);
    const readingHdr = findIndex(lines, (ln, i) => i > unitHdr && /^#\s*Reading\s*$/i.test(ln));
    ensureFound('Unit5 # Reading', readingHdr);
    const skillHdr = findIndex(lines, (ln, i) => i > readingHdr && /^##\s*\(3\)\s*Reading skill\s*$/i.test(ln));
    ensureFound('Unit5 Reading skill', skillHdr);
    const contentLines = extractSliceBetween(lines, readingHdr + 1, skillHdr);
    let title = 'Fantasy Family Farm';
    const relStart = readingHdr + 1;
    const relEnd = skillHdr;
    const h2Idx = findIndex(lines, (ln, i) => i >= relStart && i < relEnd && /^##\s*Fantasy Family Farm\s*$/i.test(ln));
    if (h2Idx >= 0) title = lines[h2Idx].replace(/^##\s+/, '').trim();
    outputs.push({ unit: 5, title, contentLines });
  }

  // Unit 6: Aunt was away (OCR shows "Ame Aunr was away") → until next "# Reading skill"
  {
    const unitHdr = findIndex(lines, (ln) => /^#\s*Ame\s+Aunr\s+was\s+away\s*$/i.test(ln));
    ensureFound('Unit6 header (OCR "Ame Aunr was away")', unitHdr);
    const skillHdr = findIndex(lines, (ln, i) => i > unitHdr && /^#\s*Reading skill\s*$/i.test(ln));
    ensureFound('Unit6 Reading skill', skillHdr);
    let start = findIndex(lines, (ln, i) => i > unitHdr && /This morning, Karen's uncle told her cousins/.test(ln));
    if (start < 0) {
      const preface = findIndex(lines, (ln, i) => i > unitHdr && /Read and find out\.?$/i.test(ln.trim()));
      if (preface >= 0) start = preface + 1;
    }
    if (start < 0) {
      start = findIndex(lines, (ln, i) => i > unitHdr && /Things to do/i.test(ln));
      if (start < 0) {
        warnings.push('Unit6: Could not find a clear narrative start; including content from unit header to Reading skill.');
        start = unitHdr + 1;
      }
    }
    const contentLines = extractSliceBetween(lines, start, skillHdr);
    const title = lines[unitHdr].replace(/^#\s+/, '').trim();
    warnings.push('Unit6 title looks OCR-corrupted: "' + title + '". Consider correcting to "Aunt was away".');
    outputs.push({ unit: 6, title, contentLines });
  }

  // Write files
  for (const { unit, title, contentLines } of outputs) {
    const slug = `u${unit}-${slugify(title) || 'reading'}`;
    const outPath = path.join(outDir, `${slug}.json`);
    const body = joinParasReflow(contentLines);
    // Prepend title as first line of content
    const content = `${title}\n\n${body}`.trim();
    writeJSON(outPath, { title, content });
    console.log(`Wrote: ${path.relative(root, outPath)} (${content.length} chars)`);
  }

  if (warnings.length) {
    console.warn('\nWarnings:');
    for (const w of warnings) console.warn('- ' + w);
  }
}

try {
  main();
} catch (err) {
  console.error('Extraction failed:', err.message);
  process.exit(1);
}

