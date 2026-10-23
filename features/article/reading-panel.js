// 「本文學習記錄」面板、正文標記與閱讀筆記匯出。
//
// 桌面為右側面板，手機為底部面板；同一份資料的篩選視圖，不維護第二份記錄。
// 同步更新只重繪受影響標記／列表，正在輸入的筆記草稿不會被遠端資料覆蓋。

import * as dom from '../../modules/dom.js';
import * as ui from '../../modules/ui.js';
import * as readingStore from '../../modules/reading-store.js';
import * as articleStore from '../../modules/article-store.js';
import * as readingActions from '../../modules/reading-actions.js';
import * as readingSync from '../../modules/reading-sync.js';
import * as readingExport from '../../modules/reading-export.js';
import { openPhrasePicker, flushPhrasePickerNote } from './phrase-picker.js';
import { t, formatDateTime } from '../../modules/i18n.js';

const FILTERS = ['all', 'words', 'sentences', 'marked', 'notes', 'ai'];
const MARKS_KEY = 'readingMarksVisible';

let panel = null;
let currentArticleId = '';
let filter = 'all';
let savedOnly = false;
let lastFocus = null;
let pendingFocusItemId = '';
const noteDrafts = new Map();
// 兩個匯出入口共用的「上次選擇」：只存在記憶體，不持久化。
// 面板 checkbox 只反映這個變數；最終匯出範圍一律以對話框為準。
let exportSelection = { fullText: false, chat: false };
let legacyImportPromise = null;
// locale 切換是非同步的（ensurePanel → openPanel → 還原）：用遞增 token 擋掉舊的還原。
let localeToken = 0;
// scope 重載會清空 reading-store 的記憶體視圖；非同步補讀必須能分辨
// 期間是否換了文章／帳戶，避免把舊結果畫回目前畫面。
let scopeRefreshToken = 0;
// Escape 關閉只需要一個 document listener；面板重建（locale 切換）不得重複綁。
let escapeHandlerBound = false;

function invalidateScopeRefresh() {
    scopeRefreshToken += 1;
}

function marksVisible() {
    try { return localStorage.getItem(MARKS_KEY) !== '0'; } catch (_) { return true; }
}

function setMarksVisible(value) {
    try { localStorage.setItem(MARKS_KEY, value ? '1' : '0'); } catch (_) {}
    applyMarks(currentArticleId);
}

function ensurePanel() {
    if (panel && panel.isConnected) return panel;
    panel = document.createElement('div');
    panel.id = 'article-reading-panel';
    panel.className = 'reading-panel hidden';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-labelledby', 'reading-panel-title');
    panel.innerHTML = `
      <div class="reading-panel-backdrop" data-close="1"></div>
      <aside class="reading-panel-sheet" role="document">
        <div class="reading-panel-head">
          <div>
            <h3 id="reading-panel-title">${t('article.readingPanelTitle')}</h3>
            <div class="reading-panel-sub" id="reading-panel-sub"></div>
          </div>
          <button type="button" class="reading-panel-close" aria-label="${t('article.close')}">×</button>
        </div>
        <div class="reading-panel-status" id="reading-panel-status" role="status" aria-live="polite"></div>
        <div class="reading-panel-filters" id="reading-panel-filters" role="toolbar" aria-label="${t('article.readingFiltersAria')}"></div>
        <div class="reading-panel-list" id="reading-panel-list"></div>
        <div class="reading-panel-foot">
          <div class="reading-export-options">
            <label><input type="checkbox" id="reading-export-fulltext" /> ${t('article.readingIncludeFullText')}</label>
            <label><input type="checkbox" id="reading-export-chat" /> ${t('article.readingIncludeChat')}</label>
          </div>
          <div class="reading-panel-actions">
            <button type="button" class="btn secondary" id="reading-article-note">${t('article.readingArticleNote')}</button>
            <button type="button" class="btn secondary" id="reading-export-md">${t('article.readingExport')}</button>
            <button type="button" class="btn tertiary" id="reading-export-json">${t('article.readingExportJson')}</button>
            <button type="button" class="btn tertiary" id="reading-ai-difficulties">${t('article.aiAnalyzeDifficulties')}</button>
            <button type="button" class="btn tertiary" id="reading-ai-notes">${t('article.aiOrganizeNotes')}</button>
          </div>
        </div>
      </aside>`;
    document.body.appendChild(panel);
    panel.querySelector('.reading-panel-close').addEventListener('click', () => closePanel());
    panel.querySelector('[data-close="1"]').addEventListener('click', () => closePanel());
    panel.querySelector('#reading-export-md').addEventListener('click', () => {
        openExportDialog({ source: 'panel' }).catch(() => {
            ui.displayMessage(t('article.readingExportFailed'), 'error');
        });
    });
    // 面板 checkbox 只當「上次選擇」的記憶，不直接決定匯出內容；
    // 兩個入口都用同一個 exportSelection，避免不同預設。
    const fullTextToggle = panel.querySelector('#reading-export-fulltext');
    const chatToggle = panel.querySelector('#reading-export-chat');
    [fullTextToggle, chatToggle].forEach((box) => {
        if (!box) return;
        box.addEventListener('change', () => {
            exportSelection = {
                fullText: !!fullTextToggle?.checked,
                chat: !!chatToggle?.checked
            };
        });
    });
    // 面板重建（例如切換介面語言）後，checkbox 要反映同一個「上次選擇」。
    syncExportSelectionUI();
    panel.querySelector('#reading-article-note').addEventListener('click', () => openArticleNoteDialog());
    panel.querySelector('#reading-export-json').addEventListener('click', async () => {
        // JSON 備份前先保存所有筆記草稿（含目前被篩選／隱藏的條目），
        // 任何一筆失敗都不匯出，避免備份缺最後修改。
        const panelFlushed = await flushNoteDrafts();
        const pickerFlushed = await flushPhrasePickerNote();
        if (!panelFlushed || !pickerFlushed.ok) {
            ui.displayMessage(t('article.saveFailedRetry'), 'error');
            return;
        }
        const backup = await readingExport.exportFullBackupFile();
        if (backup && backup.ok !== false) ui.displayMessage(t('article.readingExportJsonDone'), 'success');
        else ui.displayMessage(t('article.readingExportFailed'), 'error');
    });
    panel.querySelector('#reading-ai-difficulties').addEventListener('click', () => openAiScopeDialog('difficulties'));
    panel.querySelector('#reading-ai-notes').addEventListener('click', () => openAiScopeDialog('notes'));
    if (!escapeHandlerBound) {
        escapeHandlerBound = true;
        document.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape' || !panel || panel.classList.contains('hidden')) return;
            if (document.querySelector('#app-modal:not(.hidden)')) return;
            closePanel();
        });
    }
    return panel;
}

async function openPanel(articleId = currentArticleId, options = {}) {
    if (!articleId) {
        ui.displayMessage(t('article.readingNoArticle'), 'warning');
        return;
    }
    currentArticleId = articleId;
    const restoring = options.restore === true;
    lastFocus = restoring ? null : document.activeElement;
    pendingFocusItemId = options.focusItemId || '';
    if (pendingFocusItemId) {
        filter = 'all';
        savedOnly = false;
    }
    const element = ensurePanel();
    element.classList.remove('hidden');
    document.body.classList.add('reading-panel-open');
    if (dom.articleReadingRecordsBtn) dom.articleReadingRecordsBtn.setAttribute('aria-expanded', 'true');
    await readingStore.ensureArticleReadingLoaded(articleId).catch(() => null);
    if (currentArticleId !== articleId) return;
    renderPanel();
    applyMarks(articleId);
    const focusTarget = pendingFocusItemId
        ? element.querySelector(`[data-note-id="${CSS.escape(pendingFocusItemId)}"]`)
        : null;
    pendingFocusItemId = '';
    setTimeout(() => {
        if (focusTarget && focusTarget.isConnected) {
            focusTarget.closest('.reading-item')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            focusTarget.focus({ preventScroll: true });
        } else if (!restoring) {
            // 還原中：由呼叫端依原先的焦點位置決定，避免焦點先被拉到關閉鈕。
            element.querySelector('.reading-panel-close')?.focus({ preventScroll: true });
        }
    }, 30);
}

async function closePanel(options = {}) {
    if (!panel) return { ok: true };
    if (options.force !== true) {
        const flushed = await flushNoteDrafts();
        const pickerFlushed = await flushPhrasePickerNote();
        if (!flushed || !pickerFlushed.ok) {
            // 保存失敗不得靜默關閉：保留草稿與面板，讓使用者重試。
            ui.displayMessage(t('article.saveFailedRetry'), 'error');
            return { ok: false, error: 'note_save_failed' };
        }
    }
    panel.classList.add('hidden');
    document.body.classList.remove('reading-panel-open');
    if (dom.articleReadingRecordsBtn) dom.articleReadingRecordsBtn.setAttribute('aria-expanded', 'false');
    if (lastFocus && typeof lastFocus.focus === 'function') {
        try { lastFocus.focus({ preventScroll: true }); } catch (_) { lastFocus.focus(); }
    }
    lastFocus = null;
    return { ok: true };
}

function isPanelOpen() {
    return !!(panel && !panel.classList.contains('hidden'));
}

/**
 * 切語言前記住面板的可見狀態、篩選與閱讀位置（P3-T3）。
 * filter／savedOnly 已是 module 變數；重建 DOM 不會清掉它們，但仍一併帶入快照，
 * 讓非同步流程能驗証「還原的仍是同一組篩選」。
 */
function capturePanelState() {
    const open = isPanelOpen();
    const list = panel?.querySelector('#reading-panel-list');
    const active = document.activeElement;
    let focusedItemId = '';
    let focusKind = '';
    if (open && active && panel?.contains(active)) {
        const card = active.closest?.('.reading-item');
        if (card) {
            focusedItemId = card.getAttribute('data-item-id') || '';
            focusKind = active.classList?.contains('reading-note') ? 'note' : 'item';
        }
    }
    return {
        wasOpen: open,
        articleId: currentArticleId,
        scrollTop: list ? Number(list.scrollTop) || 0 : 0,
        focusedItemId,
        focusKind,
        filter,
        savedOnly
    };
}

/** 以 item id 找回對應節點；找不到就退回面板關閉鈕，焦點不留在 body。 */
function restorePanelView(snapshot) {
    if (!panel) return;
    const list = panel.querySelector('#reading-panel-list');
    if (list) {
        try { list.scrollTop = Math.max(0, Number(snapshot.scrollTop) || 0); } catch (_) { /* 退回頂部 */ }
    }
    if (!snapshot.focusedItemId) {
        panel.querySelector('.reading-panel-close')?.focus({ preventScroll: true });
        return;
    }
    const noteArea = panel.querySelector(`[data-note-id="${CSS.escape(snapshot.focusedItemId)}"]`);
    const card = panel.querySelector(`.reading-item[data-item-id="${CSS.escape(snapshot.focusedItemId)}"]`);
    const target = (snapshot.focusKind === 'note' && noteArea)
        ? noteArea
        : (card?.querySelector('[data-mark-toggle]') || noteArea || card);
    if (!target) {
        panel.querySelector('.reading-panel-close')?.focus({ preventScroll: true });
        return;
    }
    try { target.focus({ preventScroll: true }); } catch (_) { /* noop */ }
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function kindLabel(kind) {
    if (kind === 'phrase') return t('article.readingKindPhrase');
    if (kind === 'sentence') return t('article.readingKindSentence');
    return t('article.readingKindWord');
}

function markButtonLabel(marked) {
    return marked === true ? t('article.unmarkThis') : t('article.markThis');
}

function markedLabel(value) {
    return value === true ? t('article.readingMarkedYes') : t('article.readingMarkedNo');
}

function meaningOf(item) {
    const result = item?.explanation?.result;
    if (!result) return '';
    return String(
        result.analysis?.meaning
        || result.meaning
        || result.translation
        || (typeof result === 'string' ? result : '')
    ).trim();
}

function itemMatchesFilter(item) {
    if (filter === 'words' && !['word', 'phrase'].includes(item.kind)) return false;
    if (filter === 'sentences' && item.kind !== 'sentence') return false;
    if (filter === 'marked' && item.marked !== true) return false;
    if (filter === 'notes' && !String(item.note || '').trim()) return false;
    if (filter === 'ai') return false;
    if (savedOnly && !readingStore.isItemSaved(item.id)) return false;
    return true;
}

function filterCount(key) {
    const items = readingStore.listLearningItems(currentArticleId).filter((item) => !item.deletedAt);
    if (key === 'ai') return readingStore.listArticleDocuments(currentArticleId).filter((doc) => doc.kind === 'ai').length;
    if (key === 'all') return items.length + readingStore.listArticleDocuments(currentArticleId).filter((doc) => doc.kind === 'ai').length;
    return items.filter((item) => {
        if (key === 'words') return ['word', 'phrase'].includes(item.kind);
        if (key === 'sentences') return item.kind === 'sentence';
        if (key === 'marked') return item.marked === true;
        if (key === 'notes') return String(item.note || '').trim();
        return true;
    }).length;
}

function renderFilters() {
    const box = panel.querySelector('#reading-panel-filters');
    const labels = {
        all: t('article.readingFilterAll'),
        words: t('article.readingFilterWords'),
        sentences: t('article.readingFilterSentences'),
        marked: t('article.readingFilterMarked'),
        notes: t('article.readingFilterNotes'),
        ai: t('article.readingFilterAi')
    };
    box.innerHTML = FILTERS.map((key) => `
      <button type="button" class="reading-filter ${filter === key ? 'is-active' : ''}" data-filter="${key}" aria-pressed="${filter === key}">
        ${labels[key]} <span class="reading-filter-count">${filterCount(key)}</span>
      </button>`).join('') + `
      <label class="reading-saved-filter"><input type="checkbox" id="reading-saved-only" ${savedOnly ? 'checked' : ''} /> ${t('article.readingFilterSaved')}</label>`;
    box.querySelectorAll('[data-filter]').forEach((button) => {
        button.addEventListener('click', () => {
            filter = button.getAttribute('data-filter');
            renderPanel();
        });
    });
    box.querySelector('#reading-saved-only')?.addEventListener('change', (event) => {
        savedOnly = !!event.target.checked;
        renderPanel();
    });
}

function conflictPreview(entity) {
    if (!entity) return '—';
    const quote = entity.anchor?.quote || entity.title || entity.word || entity.id || '';
    const note = String(entity.note || entity.content || '').replace(/\s+/g, ' ').trim();
    const meaning = entity.explanation?.result?.analysis?.meaning || entity.explanation?.result?.meaning || entity.meaning || '';
    return [quote, meaning, note].filter(Boolean).join(' · ').slice(0, 220);
}

function statusHtml() {
    const meta = readingStore.getReadingMeta();
    const conflicts = readingStore.getReadingConflicts();
    const parts = [];
    if (conflicts.length) {
        parts.push(`<div class="reading-status-banner is-warning">
          <strong>${t('article.readingConflictTitle', { count: conflicts.length })}</strong>
          ${conflicts.map((conflict) => `
            <div class="reading-conflict-row" data-type="${escapeHtml(conflict.entityType)}" data-id="${escapeHtml(conflict.entityId)}">
              <div class="reading-conflict-field">${escapeHtml((conflict.fields || []).join(', '))}</div>
              <div class="reading-conflict-values">
                <div><strong>${t('article.readingConflictLocal')}</strong> ${escapeHtml(conflictPreview(conflict.local))}</div>
                <div><strong>${t('article.readingConflictRemote')}</strong> ${escapeHtml(conflictPreview(conflict.remote))}</div>
              </div>
              <button type="button" class="btn tertiary" data-choice="keep-local">${t('article.readingConflictKeepLocal')}</button>
              <button type="button" class="btn tertiary" data-choice="use-remote">${t('article.readingConflictUseRemote')}</button>
              <button type="button" class="btn tertiary" data-choice="keep-copy">${t('article.readingConflictKeepCopy')}</button>
            </div>`).join('')}
        </div>`);
    }
    if (meta.lastError === 'server_update_required') {
        parts.push(`<div class="reading-status-banner">${t('article.readingServerUpdateRequired')}</div>`);
    } else if (meta.lastError) {
        parts.push(`<div class="reading-status-banner">${t('article.readingSyncError')}</div>`);
    } else if (meta.lastSyncAt) {
        parts.push(`<div class="reading-status-banner is-muted">${t('article.readingSyncedAt', { time: formatDateTime(meta.lastSyncAt) })}</div>`);
    }
    return parts.join('');
}

function wireConflictButtons() {
    panel.querySelectorAll('.reading-conflict-row').forEach((row) => {
        row.querySelectorAll('[data-choice]').forEach((button) => {
            button.addEventListener('click', async () => {
                const type = row.getAttribute('data-type');
                const id = row.getAttribute('data-id');
                const choice = button.getAttribute('data-choice');
                button.disabled = true;
                try {
                    await readingSync.resolveReadingConflict(type, id, choice);
                    ui.displayMessage(t('article.readingConflictResolved'), 'success');
                } catch (_) {
                    ui.displayMessage(t('article.readingConflictResolveFailed'), 'error');
                } finally {
                    renderPanel();
                }
            });
        });
    });
}

function itemCardHtml(item, index) {
    const saved = readingStore.isItemSaved(item.id);
    const links = readingStore.listVocabularyLinks({ itemId: item.id });
    const bookNames = Array.from(new Set(links.map((link) => readingStore.getVocabularyBook(link.bookId)?.name).filter(Boolean)));
    const draft = noteDrafts.get(item.id);
    const noteValue = draft ? draft.value : (item.note || '');
    const noteStatus = draft?.status || '';
    const reference = `#${index + 1}`;
    return `
      <article class="reading-item ${item.marked === true ? 'is-marked' : ''}" data-item-id="${escapeHtml(item.id)}">
        <div class="reading-item-head">
          <span class="reading-kind">${kindLabel(item.kind)}</span>
          ${saved ? `<span class="reading-saved-badge" title="${t('article.readingSavedToBook')}">★ ${escapeHtml(bookNames.join(' / '))}</span>` : ''}
          ${item.firstViewedAt ? `<span class="reading-meta">${t('article.readingViewed')}</span>` : `<span class="reading-meta">${t('article.readingNotViewed')}</span>`}
          ${(item.positionUncertain || item.anchor?.start < 0) ? `<span class="reading-meta is-warning">${t('article.readingPositionUncertainShort')}</span>` : ''}
        </div>
        <div class="reading-quote">${reference} ${escapeHtml(item.anchor?.quote || '')}</div>
        ${item.sentence ? `<div class="reading-sentence">${escapeHtml(item.sentence)}</div>` : ''}
        ${meaningOf(item) ? `<div class="reading-meaning">${escapeHtml(meaningOf(item))}</div>` : `<div class="reading-meaning is-muted">${t('article.readingNoExplanation')}</div>`}
        <div class="reading-mark-row">
          <button type="button" class="reading-mark-toggle ${item.marked === true ? 'is-active' : ''}" data-mark-toggle="1" aria-pressed="${item.marked === true}" aria-label="${t('article.markToggleAria', { quote: item.anchor?.quote || '' })}">
            ${markButtonLabel(item.marked)}
          </button>
          <span class="reading-mark-state">${markedLabel(item.marked)}</span>
        </div>
        <label class="reading-note-label" for="reading-note-${escapeHtml(item.id)}">${t('article.readingNote')}</label>
        <textarea id="reading-note-${escapeHtml(item.id)}" class="reading-note" rows="2" maxlength="20000" data-note-id="${escapeHtml(item.id)}" placeholder="${t('article.readingNotePlaceholder')}">${escapeHtml(noteValue)}</textarea>
        <div class="reading-note-status" data-note-status="${escapeHtml(item.id)}" role="status">${noteStatus === 'saving' ? t('article.readingSaving') : noteStatus === 'saved' ? t('article.readingSaved') : noteStatus === 'error' ? t('article.saveFailedRetry') : ''}</div>
        <div class="reading-item-actions">
          ${!saved ? `<button type="button" class="btn tertiary" data-action="add-book">${t('article.readingAddToBook')}</button>` : ''}
          <button type="button" class="btn tertiary" data-action="locate">${t('article.readingLocate')}</button>
          <button type="button" class="btn tertiary" data-action="ask">${t('article.askAi')}</button>
          <button type="button" class="btn tertiary" data-action="delete">${t('article.delete')}</button>
        </div>
      </article>`;
}

function documentCardHtml(doc) {
    return `
      <article class="reading-doc" data-doc-id="${escapeHtml(doc.id)}">
        <div class="reading-item-head">
          <span class="reading-kind">${doc.kind === 'ai' ? t('article.readingFilterAi') : t('article.readingFilterNotes')}</span>
          <span class="reading-meta">${doc.updatedAt ? formatDateTime(doc.updatedAt) : ''}</span>
        </div>
        <div class="reading-quote">${escapeHtml(doc.title || '')}</div>
        <details>
          <summary>${t('article.readingShowContent')}</summary>
          <pre class="reading-doc-content">${escapeHtml(doc.content || '')}</pre>
        </details>
        <div class="reading-item-actions">
          <button type="button" class="btn tertiary" data-doc-action="delete">${t('article.delete')}</button>
        </div>
      </article>`;
}

function renderList() {
    const list = panel.querySelector('#reading-panel-list');
    const items = readingStore.listLearningItems(currentArticleId).filter((item) => !item.deletedAt);
    const indexed = items.map((item, index) => ({ item, index }));
    const visible = indexed.filter(({ item }) => itemMatchesFilter(item));
    const docs = readingStore.listArticleDocuments(currentArticleId, { withContent: true })
        .filter((doc) => {
            if (filter === 'ai') return doc.kind === 'ai';
            if (filter === 'notes') return doc.kind === 'note';
            if (filter === 'words' || filter === 'sentences' || filter === 'marked') return false;
            return true;
        });
    const html = [
        ...visible.map(({ item, index }) => itemCardHtml(item, index)),
        ...docs.map(documentCardHtml)
    ];
    if (!html.length) {
        list.innerHTML = `<div class="reading-empty">${t('article.readingEmpty')}</div>`;
    } else {
        list.innerHTML = html.join('');
    }
    wireItemActions();
}

async function persistNoteDraft(itemId, textarea) {
    const draft = noteDrafts.get(itemId);
    if (!draft) return { ok: true, skipped: true };
    clearTimeout(draft.timer);
    draft.timer = null;
    draft.status = 'saving';
    const statusEl = panel?.querySelector(`[data-note-status="${CSS.escape(itemId)}"]`);
    if (statusEl) statusEl.textContent = t('article.readingSaving');
    const latest = readingStore.getLearningItem(itemId);
    if (!latest) {
        draft.status = 'error';
        if (statusEl) statusEl.textContent = t('article.saveFailedRetry');
        return { ok: false, error: 'not_found' };
    }
    const result = await readingActions.saveNote(itemId, draft.value, draft.actionContext || null);
    draft.status = result.ok ? 'saved' : 'error';
    if (statusEl) {
        statusEl.innerHTML = result.ok
            ? t('article.readingSaved')
            : `${t('article.saveFailedRetry')} <button type="button" class="link-btn" data-note-retry="${escapeHtml(itemId)}">${t('article.retry')}</button>`;
        if (!result.ok) {
            statusEl.querySelector('[data-note-retry]')?.addEventListener('click', () => {
                const area = panel?.querySelector(`[data-note-id="${CSS.escape(itemId)}"]`);
                if (area) { draft.value = area.value; persistNoteDraft(itemId, area); }
            });
        }
    }
    if (result.ok) {
        setTimeout(() => { if (noteDrafts.get(itemId)?.status === 'saved') noteDrafts.delete(itemId); }, 1200);
    }
    return result;
}

async function flushNoteDrafts() {
    // 逐一保存所有草稿，不限目前篩選或畫面上可見的 textarea；
    // 隱藏／被篩掉的草稿也要在關閉、匯出前寫入。
    const pending = Array.from(noteDrafts.keys());
    let ok = true;
    for (const itemId of pending) {
        const area = panel?.querySelector(`[data-note-id="${CSS.escape(itemId)}"]`);
        const result = await persistNoteDraft(itemId, area || null);
        if (!result || result.ok === false) ok = false;
    }
    return ok;
}

// ── 匯出範圍對話框（P2-T7）───────────────────────────────────────
// 頂部按鈕與面板按鈕共用同一個對話框；先顯示數量與版本，
// 預設只匯出閱讀筆記，不默認附上全文或對話。

function exportScopeDescription(scope, selection = {}) {
    const summary = t('article.exportScopeSummary', {
        items: Number(scope.itemCount) || 0,
        notes: Number(scope.noteCount) || 0,
        messages: Number(scope.messageCount) || 0
    });
    const version = String(scope.contentVersion || '').slice(0, 12);
    const parts = [String(scope.title || '')];
    if (version) parts.push(`${t('article.readingExportVersion')}: ${version}`);
    parts.push(summary);
    if (!selection.fullText && !selection.chat && !selection.fullBackup) {
        parts.push(t('article.exportNoteOnly'));
    }
    return parts.filter(Boolean).join(' · ');
}

function syncExportSelectionUI() {
    if (!panel) return;
    const fullTextBox = panel.querySelector('#reading-export-fulltext');
    const chatBox = panel.querySelector('#reading-export-chat');
    if (fullTextBox) fullTextBox.checked = !!exportSelection.fullText;
    if (chatBox) chatBox.checked = !!exportSelection.chat;
}

function wireExportDialogDescription(overlay, scope) {
    const desc = overlay?.querySelector('.om-desc');
    if (!desc) return;
    const readSelection = () => ({
        fullText: !!overlay.querySelector('input[data-option-key="fullText"]')?.checked,
        chat: !!overlay.querySelector('input[data-option-key="chat"]')?.checked,
        fullBackup: !!overlay.querySelector('input[data-option-key="fullBackup"]')?.checked
    });
    const apply = () => { desc.textContent = exportScopeDescription(scope, readSelection()); };
    overlay.querySelectorAll('input[type="checkbox"]').forEach((box) => box.addEventListener('change', apply));
    apply();
}

async function runExportChoice({ articleId, fullText = false, chat = false, fullBackup = false }) {
    // 匯出前先 flush 面板與片語草稿（沿用既有邏輯）；任何一筆失敗都不匯出。
    const panelFlushed = await flushNoteDrafts();
    const pickerFlushed = await flushPhrasePickerNote();
    if (!panelFlushed || !pickerFlushed || pickerFlushed.ok === false) {
        ui.displayMessage(t('article.saveFailedRetry'), 'error');
        return { ok: false, error: 'note_save_failed' };
    }
    if (currentArticleId !== articleId) {
        // flush 期間切文章／帳戶：不得把匯出結果寫成目前 scope 的資料。
        ui.displayMessage(t('article.readingExportFailed'), 'error');
        return { ok: false, error: 'stale_scope' };
    }
    if (fullBackup) {
        const backup = await readingExport.exportFullBackupFile();
        if (backup && backup.ok !== false) {
            ui.displayMessage(t('article.readingExportJsonDone'), 'success');
            return backup;
        }
        ui.displayMessage(t('article.readingExportFailed'), 'error');
        return backup || { ok: false, error: 'backup_failed' };
    }
    const result = await readingExport.exportReadingNoteFile({ articleId, includeFullText: fullText, includeChat: chat });
    if (result && result.ok) ui.displayMessage(t('article.readingExportDone'), 'success');
    else ui.displayMessage(t('article.readingExportFailed'), 'error');
    return result || { ok: false, error: 'export_failed' };
}

function openExportDialog({ source = 'panel' } = {}) {
    const articleId = currentArticleId;
    if (!articleId) {
        ui.displayMessage(t('article.readingNoArticle'), 'warning');
        return Promise.resolve({ ok: false, error: 'no_article' });
    }
    return readingExport.describeReadingScope(articleId).then((scope) => {
        if (!scope || scope.ok === false) {
            ui.displayMessage(t('article.readingExportFailed'), 'error');
            return { ok: false, error: (scope && scope.error) || 'scope_failed' };
        }
        if (currentArticleId !== articleId) {
            // 讀取摘要期間已切文章／帳戶：不開對話框，避免匯出到別的 scope。
            ui.displayMessage(t('article.readingExportFailed'), 'error');
            return { ok: false, error: 'stale_scope' };
        }
        const initial = { fullText: !!exportSelection.fullText, chat: !!exportSelection.chat, fullBackup: false };
        return new Promise((resolve) => {
            const overlay = ui.showOptionsModal({
                title: t('article.exportScopeTitle'),
                description: exportScopeDescription(scope, initial),
                options: [
                    { type: 'checkbox', key: 'fullText', label: t('article.exportIncludeFullText'), default: initial.fullText },
                    { type: 'checkbox', key: 'chat', label: t('article.exportIncludeChat'), default: initial.chat },
                    { type: 'checkbox', key: 'fullBackup', label: t('article.exportFullBackup'), default: false }
                ],
                onCancel: () => resolve({ ok: false, error: 'cancelled' }),
                onConfirm: (result) => {
                    const choice = {
                        fullText: !!result?.fullText,
                        chat: !!result?.chat,
                        fullBackup: !!result?.fullBackup
                    };
                    // 完整備份不分全文／對話；一般匯出則記住這次選擇供兩個入口共用。
                    exportSelection = { fullText: choice.fullText, chat: choice.chat };
                    syncExportSelectionUI();
                    runExportChoice({ articleId, ...choice, source })
                        .then(resolve)
                        .catch(() => {
                            ui.displayMessage(t('article.readingExportFailed'), 'error');
                            resolve({ ok: false, error: 'export_failed' });
                        });
                }
            });
            wireExportDialogDescription(overlay, scope);
        });
    }).catch(() => {
        ui.displayMessage(t('article.readingExportFailed'), 'error');
        return { ok: false, error: 'scope_failed' };
    });
}

function wireItemActions() {
    panel.querySelectorAll('[data-mark-toggle]').forEach((button) => {
        button.addEventListener('click', async () => {
            const card = button.closest('.reading-item');
            const id = card.getAttribute('data-item-id');
            const item = readingStore.getLearningItem(id);
            if (!item) return;
            button.disabled = true;
            // 卡片渲染時的帳戶上下文；切換帳戶後不得把標記寫到新 scope。
            const actionContext = readingActions.captureActionContext();
            try {
                const result = await readingActions.setMarked(id, item.marked !== true, actionContext);
                if (!result.ok) throw new Error(result.error);
                ui.displayMessage(result.entity?.marked === true
                    ? t('article.markAdded')
                    : t('article.markRemoved'), 'success');
                renderPanel();
            } catch (_) {
                ui.displayMessage(t('article.saveFailedRetry'), 'error');
                button.disabled = false;
            }
        });
    });
    panel.querySelectorAll('.reading-note').forEach((textarea) => {
        const itemId = textarea.getAttribute('data-note-id');
        textarea.addEventListener('input', () => {
            const draft = noteDrafts.get(itemId) || { value: '', status: '', timer: null, actionContext: readingActions.captureActionContext() };
            draft.value = textarea.value;
            draft.status = 'saving';
            clearTimeout(draft.timer);
            const statusEl = panel.querySelector(`[data-note-status="${CSS.escape(itemId)}"]`);
            if (statusEl) statusEl.textContent = t('article.readingSaving');
            draft.timer = setTimeout(() => persistNoteDraft(itemId, textarea), 500);
            noteDrafts.set(itemId, draft);
        });
        // blur 立即寫入，不取消計時器；關閉面板／匯出時也會再 flush。
        textarea.addEventListener('blur', () => persistNoteDraft(itemId, textarea));
    });
    panel.querySelectorAll('[data-action]').forEach((button) => {
        button.addEventListener('click', async () => {
            const card = button.closest('.reading-item');
            const id = card.getAttribute('data-item-id');
            const item = readingStore.getLearningItem(id);
            if (!item) return;
            const action = button.getAttribute('data-action');
            if (action === 'locate') {
                locateItem(item);
                return;
            }
            if (action === 'ask') {
                // 只把條目引用帶入助手輸入框，讓使用者自己補問題；不代使用者直接送出。
                if (!(window.__assistant && window.__assistant.__ready)) {
                    ui.displayMessage(t('assistant.unavailable'), 'warning');
                    return;
                }
                const reference = t('article.askAiReference', { quote: item.anchor?.quote || '' });
                const context = {
                    learningItemId: item.id,
                    anchor: item.anchor,
                    contentVersion: item.contentVersion,
                    articleId: item.articleId
                };
                // 助手面板在學習記錄面板之下，先保存筆記並關閉面板，避免引用被遮住。
                const closed = await closePanel();
                if (!closed.ok) return;
                window.__assistant.compose({ text: reference, context });
                return;
            }
            if (action === 'delete') {
                const ok = await ui.confirmAction({
                    title: t('article.readingDeleteTitle'),
                    message: t('article.readingDeleteMessage'),
                    confirmLabel: t('article.delete'),
                    cancelLabel: t('common.cancel'),
                    danger: true
                });
                if (!ok) return;
                await readingStore.deleteLearningItem(id);
                noteDrafts.delete(id);
                renderPanel();
                return;
            }
            if (action === 'add-book') {
                button.disabled = true;
                try {
                    const result = await readingActions.addItemToVocabulary(item, { context: item.sentence });
                    if (!result || result.ok === false) throw new Error(result?.error || 'failed');
                    ui.displayMessage(t('article.readingAddedToBook'), 'success');
                    renderPanel();
                    applyMarks(currentArticleId);
                } catch (_) {
                    ui.displayMessage(t('article.saveFailedRetry'), 'error');
                    button.disabled = false;
                }
            }
        });
    });
    panel.querySelectorAll('[data-doc-action="delete"]').forEach((button) => {
        button.addEventListener('click', async () => {
            const card = button.closest('.reading-doc');
            const id = card.getAttribute('data-doc-id');
            await readingStore.deleteArticleDocument(id);
            renderPanel();
        });
    });
}

async function locateItem(item) {
    const candidates = Array.from(document.querySelectorAll('.interactive-sentence')).map((element) => ({
        element,
        text: (element.getAttribute('data-sentence') || element.textContent || '').trim()
    }));
    for (const entry of candidates) entry.start = sourceStartForSentence(entry.element, currentArticleId, candidates);
    const target = sourceSentenceForItem(item, candidates)?.element || null;
    if (!target) {
        ui.displayMessage(t('article.readingLocateFailed'), 'warning');
        return;
    }
    const closed = await closePanel();
    if (!closed.ok) return;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.classList.add('reading-locate-flash');
    setTimeout(() => target.classList.remove('reading-locate-flash'), 1600);
}


function openArticleNoteDialog() {
    if (!currentArticleId) {
        ui.displayMessage(t('article.readingNoArticle'), 'warning');
        return;
    }
    const existing = readingStore.listArticleDocuments(currentArticleId, { withContent: true })
        .find((doc) => doc.kind === 'note');
    ui.openModal();
    dom.modalTitle.textContent = t('article.readingArticleNoteTitle');
    dom.modalBody.innerHTML = `
      <div class="reading-article-note-editor">
        <p>${t('article.readingArticleNoteHint')}</p>
        <textarea id="reading-article-note-input" rows="12" maxlength="400000">${escapeHtml(existing?.content || '')}</textarea>
        <div class="reading-ai-actions">
          <button type="button" class="btn primary" id="reading-article-note-save">${t('article.readingSaveNote')}</button>
          <button type="button" class="btn secondary" id="reading-article-note-cancel">${t('common.cancel')}</button>
        </div>
        <div id="reading-article-note-status" role="status"></div>
      </div>`;
    dom.modalBody.querySelector('#reading-article-note-cancel').addEventListener('click', () => ui.closeModal());
    dom.modalBody.querySelector('#reading-article-note-save').addEventListener('click', async () => {
        const button = dom.modalBody.querySelector('#reading-article-note-save');
        const status = dom.modalBody.querySelector('#reading-article-note-status');
        const content = dom.modalBody.querySelector('#reading-article-note-input').value;
        button.disabled = true;
        status.textContent = t('article.readingSaving');
        const result = await readingStore.saveArticleDocument({
            id: existing?.id || '',
            articleId: currentArticleId,
            kind: 'note',
            title: t('article.readingArticleNoteTitle'),
            content,
            contentVersion: readingActions.articleVersion(currentArticleId),
            sourceItemIds: [],
            sourceMessageIds: []
        });
        if (!result.ok) {
            status.textContent = t('article.saveFailedRetry');
            button.disabled = false;
            return;
        }
        ui.closeModal();
        ui.displayMessage(t('article.readingSaved'), 'success');
        renderPanel();
    });
}

function openAiScopeDialog(mode) {
    const items = readingStore.listLearningItems(currentArticleId).filter((item) => !item.deletedAt);
    const docs = readingStore.listArticleDocuments(currentArticleId).filter((doc) => doc.kind === 'ai');
    if (!items.length && !docs.length) {
        ui.displayMessage(t('article.readingEmpty'), 'warning');
        return;
    }
    ui.openModal();
    dom.modalTitle.textContent = mode === 'difficulties' ? t('article.aiAnalyzeDifficulties') : t('article.aiOrganizeNotes');
    dom.modalBody.innerHTML = `
      <div class="reading-ai-scope">
        <p>${t('article.aiScopeHint')}</p>
        <label class="reading-ai-toggle"><input type="checkbox" id="reading-ai-include-notes" checked /> ${t('article.readingIncludeNotes')}</label>
        <div class="reading-ai-list">
          ${items.map((item) => `
            <label class="reading-ai-row">
              <input type="checkbox" class="reading-ai-item" value="${escapeHtml(item.id)}" checked />
              <span><strong>${escapeHtml(item.anchor?.quote || '')}</strong> · ${kindLabel(item.kind)} · ${markedLabel(item.marked)}</span>
            </label>`).join('')}
          ${docs.map((doc) => `
            <label class="reading-ai-row">
              <input type="checkbox" class="reading-ai-doc" value="${escapeHtml(doc.id)}" />
              <span>${escapeHtml(doc.title || t('article.readingFilterAi'))}</span>
            </label>`).join('')}
        </div>
        <div class="reading-ai-actions">
          <button type="button" class="btn primary" id="reading-ai-run">${t('article.aiGenerate')}</button>
          <button type="button" class="btn secondary" id="reading-ai-cancel">${t('common.cancel')}</button>
        </div>
        <div id="reading-ai-status" role="status"></div>
      </div>`;
    dom.modalBody.querySelector('#reading-ai-cancel').addEventListener('click', () => ui.closeModal());
    dom.modalBody.querySelector('#reading-ai-run').addEventListener('click', async () => {
        const button = dom.modalBody.querySelector('#reading-ai-run');
        const status = dom.modalBody.querySelector('#reading-ai-status');
        const itemIds = Array.from(dom.modalBody.querySelectorAll('.reading-ai-item:checked')).map((input) => input.value);
        const documentIds = Array.from(dom.modalBody.querySelectorAll('.reading-ai-doc:checked')).map((input) => input.value);
        const includeNotes = !!dom.modalBody.querySelector('#reading-ai-include-notes')?.checked;
        button.disabled = true;
        status.textContent = t('article.aiGenerating');
        try {
            const result = await readingActions.generateReadingDocument({
                articleId: currentArticleId,
                mode,
                itemIds,
                documentIds,
                includeNotes
            });
            if (!result.ok) {
                status.textContent = result.error === 'ai_not_configured'
                    ? t('article.aiNotConfigured')
                    : t('article.aiGenerateFailed');
                button.disabled = false;
                return;
            }
            ui.closeModal();
            ui.displayMessage(t('article.aiDocumentSaved'), 'success');
            renderPanel();
        } catch (error) {
            status.textContent = t('article.aiGenerateFailed');
            button.disabled = false;
        }
    });
}

function renderPanelFromStore() {
    if (!isPanelOpen()) return;
    // 正在輸入筆記時不整份重繪，避免遠端同步／scope 重載把草稿蓋掉或游標跳走。
    const active = document.activeElement;
    if (active && active.classList && active.classList.contains('reading-note')) {
        panel.querySelector('#reading-panel-status').innerHTML = statusHtml();
        wireConflictButtons();
        return;
    }
    renderPanel();
}

function applyCurrentReadingState() {
    applyMarks(currentArticleId);
    renderPanelFromStore();
}

/**
 * 同一 scope 重載（同步完成後的 reloadReadingScope）會先清空 itemsById；
 * 此時只補讀目前文章，冷文章仍維持未載入，補讀完成後才重畫標記與面板。
 */
function refreshCurrentArticleAfterScopeReload() {
    const articleId = currentArticleId;
    if (!articleId) return;
    const ctx = readingStore.captureReadingContext();
    if (!readingStore.isReadingContextActive(ctx)) return;
    const token = ++scopeRefreshToken;
    readingStore.ensureArticleReadingLoaded(articleId, ctx).then((loaded) => {
        if (token !== scopeRefreshToken) return;
        if (!loaded || loaded.ok === false) return;
        if (currentArticleId !== articleId) return;
        if (!readingStore.isReadingContextActive(ctx)) return;
        applyCurrentReadingState();
    }).catch(() => {});
}

function renderPanel() {
    if (!panel) return;
    // 正在輸入筆記時不整份重繪，避免遠端同步把草稿蓋掉或游標跳走。
    const active = document.activeElement;
    if (active && active.classList && active.classList.contains('reading-note')) return;
    const items = readingStore.listLearningItems(currentArticleId).filter((item) => !item.deletedAt);
    const docs = readingStore.listArticleDocuments(currentArticleId).filter((doc) => doc.kind === 'ai');
    panel.querySelector('#reading-panel-sub').textContent = t('article.readingPanelSub', { items: items.length, docs: docs.length });
    panel.querySelector('#reading-panel-status').innerHTML = statusHtml();
    wireConflictButtons();
    renderFilters();
    renderList();
    if (dom.articleReadingCount) {
        const count = items.length + docs.length;
        dom.articleReadingCount.textContent = String(count);
        dom.articleReadingCount.classList.toggle('hidden', count === 0);
    }
    applyMarks(currentArticleId);
}

// ─────────────────────────────────────────────────────────────────────────────
// 正文標記
// ─────────────────────────────────────────────────────────────────────────────

function clearMarks() {
    const container = dom.articleAnalysisContainer;
    if (!container) return;
    container.querySelectorAll('.reading-mark-active, .reading-mark-viewed, .reading-mark-needs, .reading-mark-saved').forEach((element) => {
        element.classList.remove('reading-mark-active', 'reading-mark-viewed', 'reading-mark-needs', 'reading-mark-saved');
    });
}

function tokenRangeInSentence(sentenceElement, quote, sentenceText, quoteStart) {
    const tokens = Array.from(sentenceElement.querySelectorAll('.interactive-word'));
    const text = String(sentenceText || '');
    const lowerText = text.toLowerCase();
    const lowerQuote = String(quote || '').toLowerCase();
    if (quoteStart == null || quoteStart < 0) return [];
    const quoteEnd = quoteStart + lowerQuote.length;
    let from = 0;
    const marked = [];
    for (const token of tokens) {
        const tokenText = (token.textContent || '').toLowerCase();
        if (!tokenText) continue;
        const at = lowerText.indexOf(tokenText, from);
        if (at < 0) continue;
        const end = at + tokenText.length;
        from = end;
        if (at < quoteEnd && end > quoteStart) marked.push(token);
    }
    return marked;
}

function sourceStartForSentence(element, articleId, sentenceList) {
    const text = (element.getAttribute('data-sentence') || element.textContent || '').trim();
    const body = articleStore.getRecord(articleId)?.article || '';
    if (!body || !text) return -1;
    const same = sentenceList.filter((item) => item.text === text);
    const index = same.findIndex((item) => item.element === element);
    if (index < 0) return -1;
    const positions = [];
    let cursor = body.indexOf(text);
    while (cursor >= 0 && positions.length < 100) {
        positions.push(cursor);
        cursor = body.indexOf(text, cursor + Math.max(1, text.length));
    }
    return positions[index] ?? -1;
}

function sourceSentenceForItem(item, sentenceList) {
    if (!item || Number(item.anchor?.start) < 0) return null;
    const start = Number(item.anchor.start);
    if (item.kind === 'sentence') {
        return sentenceList.find((entry) => Math.abs(entry.start - start) <= 2) || null;
    }
    const candidate = sentenceList.find((entry) => entry.start >= 0
        && start >= entry.start
        && start < entry.start + entry.text.length);
    if (!candidate) return null;
    return candidate;
}

function applyMarks(articleId) {
    clearMarks();
    if (!articleId || !marksVisible()) return;
    const container = dom.articleAnalysisContainer;
    if (!container) return;
    const items = readingStore.listLearningItems(articleId).filter((item) => !item.deletedAt);
    if (!items.length) return;
    const sentenceList = Array.from(container.querySelectorAll('.interactive-sentence')).map((element) => ({
        element,
        text: (element.getAttribute('data-sentence') || element.textContent || '').trim()
    }));
    for (const entry of sentenceList) entry.start = sourceStartForSentence(entry.element, articleId, sentenceList);
    for (const item of items) {
        // 位置待確認的引用不貼到第一個同字；只在面板列出，交由使用者回原文確認。
        if (item.positionUncertain || Number(item.anchor?.start) < 0) continue;
        // 只有主動標記才劃線；查閱、收藏、筆記與舊三態都不再影響正文樣式。
        if (item.marked !== true) continue;
        const sentence = sourceSentenceForItem(item, sentenceList);
        if (!sentence) continue;
        if (item.kind === 'sentence') {
            sentence.element.classList.add('reading-mark-active');
            continue;
        }
        const quoteStart = Number(item.anchor.start) - sentence.start;
        const marked = tokenRangeInSentence(sentence.element, item.anchor?.quote || '', sentence.text, quoteStart);
        for (const token of marked) token.classList.add('reading-mark-active');
    }
}

export function getCurrentArticleId() {
    return currentArticleId;
}

/** 供單詞彈窗／原生選區的「寫筆記」直接打開面板並聚焦對應筆記框。 */
export async function openReadingPanelForItem(articleId, itemId) {
    if (!articleId || !itemId) return { ok: false, error: 'missing_target' };
    if (isPanelOpen() && currentArticleId === articleId) {
        // 面板已開：先保存現有草稿再切回全部篩選，確保目標卡片存在。
        const flushed = await flushNoteDrafts();
        if (!flushed) return { ok: false, error: 'note_save_failed' };
        filter = 'all';
        savedOnly = false;
        if (document.activeElement?.classList?.contains('reading-note')) document.activeElement.blur();
        renderPanel();
        const target = panel.querySelector(`[data-note-id="${CSS.escape(itemId)}"]`);
        if (!target) return { ok: false, error: 'not_found' };
        target.closest('.reading-item')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        target.focus({ preventScroll: true });
        return { ok: true };
    }
    await openPanel(articleId, { focusItemId: itemId });
    return { ok: isPanelOpen() };
}

async function loadArticle(articleId) {
    invalidateScopeRefresh();
    const previousArticleId = currentArticleId;
    let draftsFlushed = true;
    if (previousArticleId && previousArticleId !== articleId && noteDrafts.size) {
        // 換文章前先保存上一篇文章的筆記；失敗時保留草稿（不 clear）並提示。
        draftsFlushed = await flushNoteDrafts();
        if (!draftsFlushed) ui.displayMessage(t('article.saveFailedRetry'), 'error');
        else noteDrafts.clear();
    }
    currentArticleId = articleId || '';
    if (!articleId && draftsFlushed) noteDrafts.clear();
    if (!currentArticleId) {
        if (panel) panel.classList.add('hidden');
        document.body.classList.remove('reading-panel-open');
        clearMarks();
        if (dom.articleReadingCount) dom.articleReadingCount.classList.add('hidden');
        return;
    }
    // 啟動與換文章只讀這篇的條目／文件；讀取期間若又切換文章則放棄舊結果。
    await readingStore.ensureArticleReadingLoaded(currentArticleId).catch(() => null);
    if (currentArticleId !== articleId) return;
    if (legacyImportPromise !== currentArticleId) {
        legacyImportPromise = currentArticleId;
        readingStore.importLegacyItemsForArticle(currentArticleId).catch(() => {});
    }
    if (dom.articleReadingMarksToggle) dom.articleReadingMarksToggle.checked = marksVisible();
    applyMarks(currentArticleId);
    if (isPanelOpen()) renderPanel();
    else if (dom.articleReadingCount) {
        const count = readingStore.listLearningItems(currentArticleId).filter((item) => !item.deletedAt).length
            + readingStore.listArticleDocuments(currentArticleId).filter((doc) => doc.kind === 'ai').length;
        dom.articleReadingCount.textContent = String(count);
        dom.articleReadingCount.classList.toggle('hidden', count === 0);
    }
}

export function initReadingPanel() {
    ensurePanel();
    dom.articleReadingRecordsBtn?.addEventListener('click', () => {
        if (isPanelOpen()) closePanel();
        else openPanel(currentArticleId).catch(() => null);
    });
    dom.articleReadingExportBtn?.addEventListener('click', () => {
        openExportDialog({ source: 'toolbar' }).catch(() => {
            ui.displayMessage(t('article.readingExportFailed'), 'error');
        });
    });
    if (dom.articleReadingMarksToggle) {
        dom.articleReadingMarksToggle.checked = marksVisible();
        dom.articleReadingMarksToggle.addEventListener('change', () => setMarksVisible(dom.articleReadingMarksToggle.checked));
    }
    document.addEventListener('bdc:article-loaded', (event) => {
        const articleId = event?.detail?.articleId || '';
        loadArticle(articleId).catch(() => null);
    });
    document.addEventListener('bdc:reading-change', (event) => {
        const detail = event?.detail || {};
        const articleId = detail.articleId;
        if (articleId && articleId !== currentArticleId) return;
        if (detail.reason === 'scope-reloaded') {
            // 記憶體視圖剛被清空：先按需補讀目前文章，不可直接套用空資料。
            refreshCurrentArticleAfterScopeReload();
            return;
        }
        applyCurrentReadingState();
    });
    document.addEventListener('bdc:articles-scope-changed', () => {
        // 切帳戶時舊草稿已不屬於目前 scope，不可阻擋介面切換。
        invalidateScopeRefresh();
        closePanel({ force: true });
        noteDrafts.clear();
        loadArticle('');
    });
    document.addEventListener('bdc:locale-change', async () => {
        // 切語言只重建 DOM；筆記草稿（noteDrafts）、篩選與閱讀位置留在記憶體，不可丟。
        const snapshot = capturePanelState();
        const token = ++localeToken;
        if (panel) {
            panel.remove();
            panel = null;
        }
        ensurePanel();
        if (!snapshot.wasOpen || !snapshot.articleId) {
            // 面板未開：維持原本「只重畫標記／計數」的行為。
            if (snapshot.articleId) loadArticle(snapshot.articleId);
            return;
        }
        filter = snapshot.filter;
        savedOnly = snapshot.savedOnly;
        await openPanel(snapshot.articleId, { restore: true });
        if (token !== localeToken) return;
        if (!isPanelOpen()) return;
        restorePanelView(snapshot);
        ui.displayMessage(t('article.localeKeptPanel'), 'success', 2000);
    });
    // 若模組初始化晚於文章載入，從目前狀態補一次。
    try {
        const activeId = document.querySelector('.interactive-sentence')?.getAttribute('data-article-id') || '';
        if (activeId) loadArticle(activeId);
    } catch (_) {}
}

export { openPhrasePicker };
