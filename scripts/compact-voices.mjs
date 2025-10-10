#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const [,, inFile, outFile] = process.argv;
if (!inFile || !outFile) {
  console.error('Usage: node scripts/compact-voices.mjs <voices.json> <voices.min.json>');
  process.exit(1);
}

function flatten(data){
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.voices)) return data.voices;
  const arr = [];
  if (data && typeof data === 'object') {
    for (const k of Object.keys(data)) {
      const v = data[k];
      if (Array.isArray(v)) arr.push(...v);
    }
  }
  return arr;
}

function norm(raw){
  const id = raw?.short_name || raw?.ShortName || raw?.shortName || raw?.Name || raw?.name || raw?.VoiceId || raw?.Id || raw?.id || raw?.voice || raw?.Code;
  const locale = raw?.locale || raw?.Locale || raw?.lang || raw?.language || raw?.languageCode || raw?.Language || '';
  const gender = raw?.gender || raw?.Gender || '';
  const localName = raw?.local_name || raw?.LocalName || raw?.localName || '';
  const displayName = raw?.display_name || raw?.DisplayName || raw?.displayName || raw?.FriendlyName || '';
  if (!id) return null;
  return { id: String(id), locale: String(locale||''), gender: String(gender||''), localName: String(localName||''), displayName: String(displayName||'') };
}

const raw = JSON.parse(readFileSync(inFile, 'utf8'));
const all = flatten(raw).map(norm).filter(Boolean);
const keep = all.filter(v => {
  const l = (v.locale||'').toLowerCase();
  return l.startsWith('en-us') || l.startsWith('en-gb') || l.startsWith('zh-cn') || l.startsWith('zh-hk') || l.startsWith('yue');
});

// Deterministic sort
keep.sort((a,b)=> (a.locale.localeCompare(b.locale) || a.id.localeCompare(b.id)));
writeFileSync(outFile, JSON.stringify(keep), 'utf8');
console.log(`compact voices written: ${outFile} (${keep.length} items)`);

