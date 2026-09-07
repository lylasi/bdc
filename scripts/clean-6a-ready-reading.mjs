#!/usr/bin/env node
/**
 * Clean the generated 6A ready-reading records.
 *
 * The source records contain both reading passages and teaching notes in one
 * Markdown string.  The article feature treats that string as reading text,
 * so this script keeps the actual passage in `content` and moves the rest to
 * metadata/supplementary fields.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const articleDir = path.join(root, 'articles', '6a ready reading');

function cleanInlineMarkdown(value) {
    return String(value || '')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*(.*?)\*\*/g, '$1')
        .replace(/__(.*?)__/g, '$1')
        .replace(/\*([^*\n]+)\*/g, '$1')
        .replace(/_([^_\n]+)_/g, '$1')
        .replace(/\\&/g, '&')
        .replace(/[ \t]+/g, ' ')
        .trim();
}

function cleanLine(rawLine) {
    let line = String(rawLine || '').replace(/\r/g, '').trim();
    if (!line) return '';
    if (/^!\[[^\]]*\]\([^)]*\)\s*$/i.test(line)) return '';
    if (/^#{1,6}\s+/.test(line)) return '';
    if (/^[-*_]{3,}\s*$/.test(line)) return '';

    line = line.replace(/^>\s?/, '');
    line = line.replace(/^[-*+]\s+/, '');
    line = line.replace(/^\d+[.)]\s+/, '');
    return cleanInlineMarkdown(line);
}

function cleanBlock(rawLines) {
    const source = rawLines.map(line => String(line || '').trim()).filter(Boolean);
    const cleaned = source.map(cleanLine).filter(Boolean);
    if (!cleaned.length) return '';

    const isListLine = line => /^[-*+]\s+/.test(line) || /^\d+[.)]\s+/.test(line);
    const isList = source.some(isListLine);
    const separator = isList ? '; ' : ' ';
    if (isList && !isListLine(source[0]) && source.slice(1).some(isListLine)) {
        return `${cleaned[0]} ${cleaned.slice(1).join(separator)}`.replace(/\s+/g, ' ').trim();
    }
    return cleaned.join(separator).replace(/\s+/g, ' ').trim();
}

function splitBlocks(lines) {
    const blocks = [];
    let current = [];
    const flush = () => {
        if (current.length) blocks.push(current);
        current = [];
    };

    for (const line of lines) {
        if (!String(line || '').trim()) flush();
        else current.push(line);
    }
    flush();
    return blocks;
}

function extractMetadata(lines) {
    const metadata = {};
    for (const line of lines) {
        const clean = cleanLine(line);
        const match = clean.match(/^([^:]+):\s*(.+)$/);
        if (!match) continue;
        const key = match[1].trim().toLowerCase();
        const value = match[2].trim();
        if (key === 'printed page(s)') metadata.printedPages = value;
        else if (key === 'text types') metadata.textTypes = value;
        else if (key === 'pre-reading prompt') metadata.preReadingPrompt = value;
    }
    return metadata;
}

function extractSupplementary(lines) {
    const discussions = [];
    const subjectNotes = [];
    const readingLines = [];
    let i = 0;

    while (i < lines.length) {
        const trimmed = String(lines[i] || '').trim();
        if (/^>\s*(?:💬|🚀)/.test(trimmed)) {
            const quote = [];
            while (i < lines.length && /^>\s?/.test(String(lines[i] || '').trim())) {
                quote.push(String(lines[i]).replace(/^\s*>\s?/, '').trim());
                i += 1;
            }
            const value = cleanBlock(quote);
            if (value) discussions.push(value);
            continue;
        }
        if (/^\*Subject:/i.test(trimmed)) {
            const value = cleanInlineMarkdown(trimmed);
            if (value) subjectNotes.push(value);
            i += 1;
            continue;
        }
        readingLines.push(lines[i]);
        i += 1;
    }

    return { readingLines, discussions, subjectNotes };
}

function cleanArticle(article, fileName) {
    const original = String(article.content || '').replace(/\r\n?/g, '\n');
    const lines = original.split('\n');
    const coreStart = lines.findIndex(line => /^###\s+/.test(String(line || '').trim()));
    if (coreStart < 0) {
        if (article.metadata || article.supplementary) return null;
        throw new Error(`${fileName}: cannot find the reading section anchor`);
    }

    const metadata = extractMetadata(lines.slice(0, coreStart));
    const sourceBody = lines.slice(coreStart);
    const extraStart = sourceBody.findIndex(line => /^###\s+📌\s+Inserted Learning/i.test(String(line || '').trim()));
    const readingBody = extraStart >= 0 ? sourceBody.slice(0, extraStart) : sourceBody;
    const learningElements = extraStart >= 0 ? sourceBody.slice(extraStart).join('\n').trim() : '';

    const { readingLines, discussions, subjectNotes } = extractSupplementary(readingBody);
    const content = splitBlocks(readingLines)
        .map(cleanBlock)
        .filter(Boolean)
        .join('\n\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    const cleaned = {
        title: article.title || '',
        content
    };
    if (Object.keys(metadata).length) cleaned.metadata = metadata;

    const supplementary = {};
    if (discussions.length) supplementary.discussionQuestions = discussions;
    if (subjectNotes.length) supplementary.subjectNotes = subjectNotes;
    if (learningElements) supplementary.learningElementsMarkdown = learningElements;
    if (Object.keys(supplementary).length) cleaned.supplementary = supplementary;
    return cleaned;
}

const files = fs.readdirSync(articleDir)
    .filter(fileName => fileName.endsWith('.json'))
    .sort();

for (const fileName of files) {
    const filePath = path.join(articleDir, fileName);
    const article = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const cleaned = cleanArticle(article, fileName);
    if (!cleaned) {
        console.log(`Skipped already-clean ${path.relative(root, filePath)}`);
        continue;
    }
    fs.writeFileSync(filePath, `${JSON.stringify(cleaned, null, 2)}\n`, 'utf8');
    console.log(`Cleaned ${path.relative(root, filePath)} (${cleaned.content.length} content chars)`);
}
