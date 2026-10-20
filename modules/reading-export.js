// 閱讀筆記 Markdown 與完整 JSON 備份（完全在本機生成）。
//
// 匯出時先固定資料快照；不會邊讀邊因同步而漏項。若仍有未保存／待同步／
// 衝突，會在文件開頭明確標示範圍，而不是宣稱包含全部裝置資料。

import * as articleStore from './article-store.js';
import * as readingStore from './reading-store.js';
import { buildLocalSnapshot } from './sync-core.js';
import { t, formatDateTime } from './i18n.js';
import { contentVersionOf } from '../shared/reading-protocol.mjs';

function isoOrEmpty(value) {
    return value ? String(value) : '';
}

function formatTime(value) {
    if (!value) return t('article.readingUnknownTime');
    try { return formatDateTime(value); } catch (_) { return String(value); }
}

function cleanInline(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

function quoteLine(text) {
    return String(text || '').split(/\r?\n/).map((line) => `> ${line}`).join('\n');
}

function meaningOf(item) {
    const result = item?.explanation?.result;
    if (!result) return '';
    return cleanInline(
        result.analysis?.meaning
        || result.meaning
        || result.translation
        || (typeof result === 'string' ? result : '')
    );
}

function usageOf(item) {
    const result = item?.explanation?.result;
    return cleanInline(result?.analysis?.usage || result?.usage || '');
}

function markedLabel(value) {
    return value === true ? t('article.readingMarkedYes') : t('article.readingMarkedNo');
}

function itemReference(item, index) {
    return `#${index + 1} ${item.anchor?.quote || item.sentence || ''}`.trim();
}

function vocabularyLabel(item, vocabulary) {
    const links = vocabulary.links.filter((link) => (
        link && !link.deletedAt && !link.removedAt && link.itemId === item.id
    ));
    if (!links.length) return '';
    const names = links.map((link) => {
        const entry = vocabulary.entries.get(link.entryId);
        const book = vocabulary.books.get(link.bookId);
        return `${entry?.word || item.anchor?.quote || ''}${book?.name ? ` · ${book.name}` : ''}`;
    });
    return Array.from(new Set(names)).join('；');
}

export async function buildReadingNoteMarkdown({
    articleId,
    includeFullText = false,
    includeChat = false,
    documentIds = null
} = {}) {
    // 入口同步捕捉 scope + generation；下面所有內容都只從同一交易快照取，
    // 不再讀取任何可變的全域 Map。切帳戶後舊匯出回傳 stale_scope。
    const ctx = readingStore.captureReadingContext();
    if (!readingStore.isReadingContextActive(ctx)) return { ok: false, error: 'stale_scope' };
    // 一致快照：文章、條目、文件、會話、消息、詞書與同步狀態同交易讀取。
    const snapshot = await readingStore.exportArticleReading(articleId, ctx);
    if (!snapshot.ok) return { ok: false, error: snapshot.error || 'snapshot_failed' };
    if (!readingStore.isReadingContextActive(ctx)) return { ok: false, error: 'stale_scope' };
    const articleDoc = snapshot.articleDoc;
    if (!articleDoc) return { ok: false, error: 'article_not_found' };
    const record = {
        articleId,
        title: articleDoc.title || '',
        article: articleDoc.body || '',
        sourceType: articleDoc.sourceType || 'paste',
        sourceUrl: articleDoc.sourceUrl || ''
    };
    const items = snapshot.learningItems
        .filter((item) => !item.deletedAt)
        .sort((a, b) => Number(a.anchor?.start) - Number(b.anchor?.start));
    const docs = snapshot.articleDocuments
        .filter((doc) => !doc.deletedAt && (!documentIds || documentIds.includes(doc.id)));
    const conversations = includeChat ? snapshot.conversations.filter((conv) => !conv.deletedAt) : [];
    const chatByConversation = snapshot.messagesByConversation;
    const vocabulary = {
        books: new Map(snapshot.vocabularyBooks.map((book) => [book.id, book])),
        entries: new Map(snapshot.vocabularyEntries.map((entry) => [entry.id, entry])),
        links: snapshot.vocabularyLinks
    };
    const version = contentVersionOf(record.article || '');
    const pendingCount = Number(snapshot.articleOutboxCount) + Number(snapshot.readingOutboxCount);
    const readingState = snapshot.readingState || {};
    const articleState = snapshot.articleState || {};
    const lastError = readingState.lastError || articleState.lastError || '';
    const conflicts = Object.values(readingState.conflicts || {}).concat(Object.values(articleState.conflicts || {}));
    const exportedAt = new Date().toISOString();

    const words = items.filter((item) => item.kind === 'word' || item.kind === 'phrase');
    const sentences = items.filter((item) => item.kind === 'sentence');
    const markedItems = items.filter((item) => item.marked === true);
    const noteItems = items.filter((item) => String(item.note || '').trim());
    const noteDocs = docs.filter((doc) => doc.kind === 'note');
    const aiDocs = docs.filter((doc) => doc.kind === 'ai');

    const lines = [];
    lines.push(`# ${record.title || t('article.untitled')}`);
    lines.push('');
    lines.push(`- ${t('article.readingExportSource')}: ${record.sourceUrl || record.sourceType || '—'}`);
    lines.push(`- ${t('article.readingExportVersion')}: \`${version}\``);
    lines.push(`- ${t('article.readingExportTime')}: ${formatDateTime(exportedAt)}`);
    if (pendingCount || lastError) {
        lines.push(`- ${t('article.readingExportCaveat')}: ${t('article.readingExportCaveatPending')}`);
    }
    if (conflicts.length) {
        lines.push(`- ${t('article.readingExportCaveat')}: ${t('article.readingExportCaveatConflicts', { count: conflicts.length })}`);
    }
    const uncertain = items.filter((item) => item.positionUncertain || item.anchor?.start < 0);
    if (uncertain.length) {
        lines.push(`- ${t('article.readingExportCaveat')}: ${t('article.readingExportCaveatPosition', { count: uncertain.length })}`);
    }
    lines.push('');

    lines.push(`## ${t('article.readingSectionWords')}`);
    lines.push('');
    if (!words.length) {
        lines.push(t('article.readingEmptySection'));
        lines.push('');
    } else {
        const seen = new Set();
        words.forEach((item, index) => {
            const ref = itemReference(item, items.indexOf(item));
            // 以穩定條目 ID 去重：同一 quote 的不同 occurrence／版本不可被吃掉。
            const key = item.id || `${item.contentVersion}|${item.anchor?.start}|${item.anchor?.end}|${item.anchor?.quote}`;
            if (seen.has(key)) return;
            seen.add(key);
            const meaning = meaningOf(item);
            const usage = usageOf(item);
            const vocab = vocabularyLabel(item, vocabulary);
            const viewed = item.firstViewedAt ? t('article.readingViewed') : t('article.readingNotViewed');
            lines.push(`### ${ref}`);
            if (item.sentence) {
                lines.push(quoteLine(item.sentence));
                lines.push('');
            }
            lines.push(`- ${t('article.readingMeaning')}: ${meaning || '—'}`);
            if (usage) lines.push(`- ${t('article.readingUsage')}: ${usage}`);
            lines.push(`- ${t('article.readingState')}: ${viewed} · ${t('article.readingMarkState')}: ${markedLabel(item.marked)}`);
            if (vocab) lines.push(`- ${t('article.readingSavedToBook')}: ${vocab}`);
            if (item.note) lines.push(`- ${t('article.readingNote')}: ${item.note}`);
            if (item.positionUncertain || item.anchor?.start < 0) {
                lines.push(`- ${t('article.readingPositionUncertain')}`);
            }
            lines.push('');
        });
    }

    lines.push(`## ${t('article.readingSectionSentences')}`);
    lines.push('');
    if (!sentences.length) {
        lines.push(t('article.readingEmptySection'));
        lines.push('');
    } else {
        sentences.forEach((item) => {
            const ref = itemReference(item, items.indexOf(item));
            lines.push(`### ${ref}`);
            if (item.sentence) {
                lines.push(quoteLine(item.sentence));
                lines.push('');
            }
            const translation = cleanInline(item.explanation?.result?.translation || '');
            if (translation) lines.push(`- ${t('article.readingTranslation')}: ${translation}`);
            lines.push(`- ${t('article.readingState')}: ${item.firstViewedAt ? t('article.readingViewed') : t('article.readingNotViewed')} · ${t('article.readingMarkState')}: ${markedLabel(item.marked)}`);
            if (item.note) lines.push(`- ${t('article.readingNote')}: ${item.note}`);
            lines.push('');
        });
    }

    lines.push(`## ${t('article.readingSectionNotes')}`);
    lines.push('');
    if (!noteItems.length && !noteDocs.length) {
        lines.push(t('article.readingEmptySection'));
        lines.push('');
    } else {
        for (const item of noteItems) {
            lines.push(`- ${itemReference(item, items.indexOf(item))}: ${item.note}`);
        }
        if (noteItems.length && noteDocs.length) lines.push('');
        for (const doc of noteDocs) {
            lines.push(`### ${doc.title || t('article.readingSectionNotes')}`);
            lines.push('');
            lines.push(doc.content || '');
            lines.push('');
        }
    }
    lines.push('');

    lines.push(`## ${t('article.readingSectionMarked')}`);
    lines.push('');
    if (!markedItems.length) {
        lines.push(t('article.readingEmptySection'));
        lines.push('');
    } else {
        for (const item of markedItems) {
            lines.push(`- ${itemReference(item, items.indexOf(item))} — ${meaningOf(item) || t('article.readingSeeAbove')}`);
        }
    }
    lines.push('');

    lines.push(`## ${t('article.readingSectionAi')}`);
    lines.push('');
    if (!aiDocs.length) {
        lines.push(t('article.readingEmptySection'));
        lines.push('');
    } else {
        for (const doc of aiDocs) {
            lines.push(`### ${doc.title || t('article.aiNotesTitle')}`);
            lines.push('');
            lines.push(doc.content || '');
            lines.push('');
            lines.push(`- ${t('article.readingAiSourceMessages')}: ${(doc.sourceMessageIds || []).join(', ') || '—'}`);
            lines.push(`- ${t('article.readingAiSourceItems')}: ${(doc.sourceItemIds || []).map((id) => {
                const index = items.findIndex((item) => item.id === id);
                return index >= 0 ? `#${index + 1}` : id;
            }).join(', ') || '—'}`);
            lines.push('');
        }
    }

    if (includeFullText) {
        lines.push(`## ${t('article.readingSectionFullText')}`);
        lines.push('');
        lines.push(record.article || '');
        lines.push('');
    }

    if (includeChat) {
        lines.push(`## ${t('article.readingSectionChat')}`);
        lines.push('');
        if (!conversations.length) {
            lines.push(t('article.readingEmptySection'));
            lines.push('');
        } else {
            for (const conv of conversations) {
                lines.push(`### ${conv.title || t('assistant.session')}`);
                lines.push('');
                const messages = chatByConversation.get(conv.id) || [];
                // 沒有載入到訊息時明確提示，不假裝完整。
                if (!Array.isArray(messages) || !messages.length) {
                    lines.push(t('article.readingChatNotLoaded'));
                    lines.push('');
                    continue;
                }
                for (const message of messages) {
                    lines.push(`**${message.role === 'user' ? t('article.readingChatUser') : t('article.readingChatAssistant')}** (${formatTime(message.createdAt)})`);
                    lines.push('');
                    lines.push(message.content || '');
                    lines.push('');
                }
            }
        }
    }

    return {
        ok: true,
        markdown: lines.join('\n').replace(/\n{3,}/g, '\n\n'),
        meta: {
            articleId,
            contentVersion: version,
            exportedAt,
            itemCount: items.length,
            documentCount: docs.length,
            conflictCount: conflicts.length,
            pending: pendingCount > 0 || !!lastError
        }
    };
}

export function downloadTextFile(filename, text, mime = 'text/markdown;charset=utf-8') {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function readingNoteFilename(articleId, suffix = 'reading-notes') {
    const record = articleStore.getRecord(articleId);
    const base = String(record?.title || articleId || 'article')
        .replace(/[\\/:*?"<>|]+/g, ' ')
        .replace(/\s+/g, '-')
        .slice(0, 60) || 'article';
    return `${base}-${suffix}.md`;
}

export async function exportReadingNoteFile(options = {}) {
    const built = await buildReadingNoteMarkdown(options);
    if (!built.ok) return built;
    downloadTextFile(readingNoteFilename(options.articleId), built.markdown);
    return built;
}

/**
 * 完整 JSON 備份：文章、學習條目、詞書、關聯、文件、全部消息、原文版本，
 * 以及既有快照群組。沒有 50 條消息上限。
 */
export async function buildFullBackup() {
    // 文章與閱讀各自有 generation；必須在入口分別捕捉自己的上下文，不能把
    // 閱讀 ctx 傳給文章層，否則正常情況下世代不同會被當成 stale 回空陣列。
    const readingCtx = readingStore.captureReadingContext();
    const articleCtx = articleStore.captureArticleContext();
    const sameScope = () => readingCtx.scope === articleCtx.scope
        && readingStore.isReadingContextActive(readingCtx)
        && articleStore.isArticleContextActive(articleCtx);
    if (!readingStore.isReadingContextActive(readingCtx)) return { ok: false, error: 'stale_scope' };
    if (!articleStore.isArticleContextActive(articleCtx)) return { ok: false, error: 'stale_scope' };
    if (readingCtx.scope !== articleCtx.scope) return { ok: false, error: 'scope_mismatch' };
    const snapshot = await buildLocalSnapshot();
    if (!sameScope()) return { ok: false, error: 'stale_scope' };
    const reading = await readingStore.exportAll(readingCtx);
    if (!reading.ok) return reading;
    if (!sameScope()) return { ok: false, error: 'stale_scope' };
    if (reading.scope && reading.scope !== readingCtx.scope) return { ok: false, error: 'scope_mismatch' };
    const articleExport = await articleStore.exportDocumentsResult(articleCtx);
    if (!sameScope()) return { ok: false, error: 'stale_scope' };
    if (!articleExport.ok) return { ok: false, error: articleExport.error || 'article_export_failed' };
    if (articleExport.scope && articleExport.scope !== readingCtx.scope) return { ok: false, error: 'scope_mismatch' };
    return {
        ok: true,
        schemaVersion: 2,
        kind: 'bdc-full-backup',
        exportedAt: new Date().toISOString(),
        scope: readingCtx.scope,
        payload: {
            ...(snapshot?.payload || {}),
            articleDocuments: articleExport.documents,
            reading
        }
    };
}

export async function exportFullBackupFile() {
    const backup = await buildFullBackup();
    if (!backup || backup.ok === false) return backup || { ok: false, error: 'backup_failed' };
    downloadTextFile(`bdc-full-backup-${Date.now()}.json`, JSON.stringify(backup, null, 2), 'application/json;charset=utf-8');
    return backup;
}
