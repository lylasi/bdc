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
import { markdownToHtml } from '../../modules/markdown.js';
import { READING_FILTERS as FILTERS, readingMeaning as meaningOf, selectReadingRecords } from './reading-view.js';

const MODAL_QUERY = '(max-width: 1199px)';
const MARKS_KEY = 'readingMarksVisible';

let panel = null;
let currentArticleId = '';
let filter = 'all';
let savedOnly = false;
let search = '';
let sort = 'source';
let loadState = 'ready';
let loadToken = 0;
let undoState = null;
let returnState = null;
let inertObserver = null;
const inertElements = new Map();
const expandedItems = new Set();
let lastFocus = null;
let pendingFocusItemId = '';
const noteDrafts = new Map();
// 兩個匯出入口共用的「上次選擇」：只存在記憶體，不持久化。
// 最終範圍只在匯出對話框選擇，避免工具區重複佔位。
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

function isModalPanel() {
    return window.matchMedia(MODAL_QUERY).matches;
}

function childDialog() {
    return document.querySelector('#app-modal:not(.hidden), .options-modal-overlay');
}

function releaseInert() {
    inertObserver?.disconnect();
    inertObserver = null;
    for (const [element, inert] of inertElements) element.inert = inert;
    inertElements.clear();
}

function syncPanelLayout() {
    const modal = isPanelOpen() && isModalPanel();
    panel?.setAttribute('aria-modal', String(modal));
    document.body.classList.toggle('reading-panel-modal', modal);
    if (!modal) {
        releaseInert();
        return;
    }
    const apply = () => {
        for (const element of document.body.children) {
            if (element === panel || element.id === 'app-modal' || element.classList.contains('options-modal-overlay')
                || element.matches('script, style, link')) continue;
            if (!inertElements.has(element)) inertElements.set(element, element.inert);
            element.inert = true;
        }
    };
    apply();
    if (!inertObserver) {
        inertObserver = new MutationObserver(apply);
        inertObserver.observe(document.body, { childList: true });
    }
    const viewport = window.visualViewport;
    panel.style.setProperty('--reading-viewport-height', `${viewport?.height || window.innerHeight}px`);
    panel.style.setProperty('--reading-viewport-top', `${viewport?.offsetTop || 0}px`);
}

function ensurePanel() {
    if (panel && panel.isConnected) return panel;
    panel = document.createElement('div');
    panel.id = 'article-reading-panel';
    panel.className = 'reading-panel hidden';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-labelledby', 'reading-panel-title');
    const labels = filterLabels();
    panel.innerHTML = `
      <div class="reading-panel-backdrop" data-close="1"></div>
      <aside class="reading-panel-sheet" role="document">
        <div class="reading-panel-head">
          <div><h3 id="reading-panel-title">${t('article.readingPanelTitle')}</h3><div class="reading-panel-sub" id="reading-panel-sub"></div></div>
          <button type="button" class="reading-panel-close" aria-label="${t('article.close')}">×</button>
        </div>
        <div class="reading-panel-status" id="reading-panel-status" role="status" aria-live="polite"></div>
        <div class="reading-panel-controls">
          <input type="search" id="reading-search" class="reading-search" aria-label="${t('article.readingSearch')}" placeholder="${t('article.readingSearch')}" />
          <div class="reading-panel-filters" id="reading-panel-filters" role="group" aria-label="${t('article.readingFiltersAria')}">
            ${FILTERS.map(key => `<button type="button" class="reading-filter" data-filter="${key}" aria-pressed="false">${labels[key]} <span class="reading-filter-count">0</span></button>`).join('')}
          </div>
          <div class="reading-list-options">
            <label class="reading-saved-filter"><input type="checkbox" id="reading-saved-only" /> ${t('article.readingFilterSaved')}</label>
            <select id="reading-sort" aria-label="${t('article.readingSort')}">
              <option value="source">${t('article.readingSortSource')}</option><option value="viewed">${t('article.readingSortViewed')}</option><option value="updated">${t('article.readingSortUpdated')}</option>
            </select>
          </div>
          <div id="reading-results" class="reading-results" role="status" aria-live="polite"></div>
        </div>
        <div id="reading-undo" class="reading-undo hidden" role="status"></div>
        <div class="reading-panel-list" id="reading-panel-list" role="list" aria-label="${t('article.readingPanelTitle')}"></div>
        <div class="reading-panel-foot">
          <div class="reading-panel-actions">
            <button type="button" class="btn secondary" id="reading-article-note">${t('article.readingArticleNote')}</button>
            <button type="button" class="btn secondary" id="reading-export-md">${t('article.readingExport')}</button>
            <details class="reading-tools"><summary class="btn tertiary">${t('article.readingMoreTools')}</summary><div class="reading-tools-menu">
              <button type="button" class="btn tertiary" id="reading-export-json">${t('article.readingExportAccountBackup')}</button>
              <button type="button" class="btn tertiary" id="reading-ai-difficulties">${t('article.aiAnalyzeDifficulties')}</button>
              <button type="button" class="btn tertiary" id="reading-ai-notes">${t('article.aiOrganizeNotes')}</button>
            </div></details>
          </div>
        </div>
      </aside>`;
    document.body.appendChild(panel);
    if (!document.getElementById('reading-return')) {
        const button = document.createElement('button');
        button.id = 'reading-return';
        button.className = 'btn secondary reading-return hidden';
        button.addEventListener('click', async () => {
            const snapshot = returnState;
            if (!snapshot || snapshot.articleId !== currentArticleId) return;
            await openPanel(currentArticleId, { restore: true });
            restorePanelView(snapshot);
            returnState = null;
            button.classList.add('hidden');
        });
        document.body.appendChild(button);
    }
    document.getElementById('reading-return').textContent = t('article.readingReturn');
    panel.querySelector('.reading-panel-close').addEventListener('click', () => closePanel());
    panel.querySelector('[data-close="1"]').addEventListener('click', () => closePanel());
    panel.querySelector('#reading-export-md').addEventListener('click', () => {
        openExportDialog({ source: 'panel' }).catch(() => ui.displayMessage(t('article.readingExportFailed'), 'error'));
    });
    panel.querySelector('#reading-article-note').addEventListener('click', () => openArticleNoteDialog());
    panel.querySelector('#reading-export-json').addEventListener('click', () => {
        panel.querySelector('.reading-tools').open = false;
        openExportDialog({ source: 'panel', fullBackup: true });
    });
    for (const [id, mode] of [['reading-ai-difficulties', 'difficulties'], ['reading-ai-notes', 'notes']]) {
        panel.querySelector(`#${id}`).addEventListener('click', () => {
            panel.querySelector('.reading-tools').open = false;
            openAiScopeDialog(mode);
        });
    }
    panel.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
        filter = button.dataset.filter;
        renderPanel();
        panel.querySelector('#reading-panel-list').scrollTop = 0;
    }));
    panel.querySelector('#reading-saved-only').addEventListener('change', event => {
        savedOnly = event.target.checked;
        renderPanel();
    });
    panel.querySelector('#reading-search').addEventListener('input', event => {
        search = event.target.value;
        renderPanel();
        panel.querySelector('#reading-panel-list').scrollTop = 0;
    });
    panel.querySelector('#reading-sort').addEventListener('change', event => {
        sort = event.target.value;
        renderPanel();
    });
    if (!escapeHandlerBound) {
        escapeHandlerBound = true;
        document.addEventListener('keydown', event => {
            if (!isPanelOpen() || childDialog()) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                const tools = panel.querySelector('.reading-tools');
                if (tools.open) {
                    tools.open = false;
                    tools.querySelector('summary').focus({ preventScroll: true });
                    return;
                }
                closePanel();
            } else if (event.key === 'Tab' && isModalPanel()) {
                const targets = Array.from(panel.querySelectorAll('button, input, textarea, select, summary, a[href]'))
                    .filter(element => !element.disabled && element.tabIndex >= 0 && element.getClientRects().length
                        && !element.closest('details:not([open]) > :not(summary)')
                        && element.checkVisibility?.({ checkVisibilityCSS: true, contentVisibilityAuto: true }) !== false);
                const first = targets[0];
                const last = targets.at(-1);
                if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
                    event.preventDefault(); last?.focus();
                } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
                    event.preventDefault(); first?.focus();
                }
            }
        });
        window.addEventListener('resize', syncPanelLayout);
        window.visualViewport?.addEventListener('resize', syncPanelLayout);
        window.visualViewport?.addEventListener('scroll', syncPanelLayout);
        document.addEventListener('bdc:modal-closed', () => {
            if (isPanelOpen() && !panel.contains(document.activeElement)) panel.querySelector('.reading-panel-close')?.focus({ preventScroll: true });
        });
        document.addEventListener('click', event => {
            if (!isPanelOpen()) return;
            const tools = panel.querySelector('.reading-tools');
            if (tools.open && !tools.contains(event.target)) tools.open = false;
        });
    }
    return panel;
}

async function readPanelArticle(articleId) {
    const token = ++loadToken;
    loadState = 'loading';
    renderPanel();
    const result = await readingStore.ensureArticleReadingLoaded(articleId).catch(() => ({ ok: false }));
    if (token !== loadToken || articleId !== currentArticleId) return;
    loadState = result?.ok ? 'ready' : 'error';
    renderPanel();
}

async function openPanel(articleId = currentArticleId, options = {}) {
    if (!articleId) {
        ui.displayMessage(t('article.readingNoArticle'), 'warning');
        return;
    }
    currentArticleId = articleId;
    const restoring = options.restore === true;
    if (!restoring) lastFocus = document.activeElement;
    else if (!lastFocus?.isConnected) lastFocus = dom.articleReadingRecordsBtn;
    pendingFocusItemId = options.focusItemId || '';
    if (pendingFocusItemId) {
        filter = 'all'; savedOnly = false; search = '';
        expandedItems.add(pendingFocusItemId);
    }
    const element = ensurePanel();
    element.classList.remove('hidden');
    document.body.classList.add('reading-panel-open');
    document.getElementById('reading-return')?.classList.add('hidden');
    syncPanelLayout();
    dom.articleReadingRecordsBtn?.setAttribute('aria-expanded', 'true');
    element.querySelector('.reading-panel-close')?.focus({ preventScroll: true });
    await readPanelArticle(articleId);
    if (currentArticleId !== articleId || !isPanelOpen()) return;
    applyMarks(articleId);
    const target = pendingFocusItemId ? element.querySelector(`[data-note-id="${CSS.escape(pendingFocusItemId)}"]`) : null;
    pendingFocusItemId = '';
    if (target) {
        target.closest('.reading-item')?.scrollIntoView({ block: 'center' });
        target.focus({ preventScroll: true });
    }
}

async function closePanel(options = {}) {
    if (!panel) return { ok: true };
    if (options.force !== true) {
        const flushed = await flushNoteDrafts();
        const pickerFlushed = await flushPhrasePickerNote();
        if (!flushed || !pickerFlushed.ok) {
            ui.displayMessage(t('article.saveFailedRetry'), 'error');
            return { ok: false, error: 'note_save_failed' };
        }
    }
    ++loadToken;
    panel.classList.add('hidden');
    document.body.classList.remove('reading-panel-open');
    syncPanelLayout();
    dom.articleReadingRecordsBtn?.setAttribute('aria-expanded', 'false');
    if (lastFocus?.isConnected && typeof lastFocus.focus === 'function') lastFocus.focus({ preventScroll: true });
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
    let noteSelection = null;
    if (open && active && panel?.contains(active)) {
        const card = active.closest?.('.reading-item');
        if (card) {
            focusedItemId = card.getAttribute('data-item-id') || '';
            focusKind = active.classList?.contains('reading-note') ? 'note' : 'item';
            if (focusKind === 'note' && Number.isInteger(active.selectionStart)) {
                noteSelection = {
                    start: active.selectionStart,
                    end: Number.isInteger(active.selectionEnd) ? active.selectionEnd : active.selectionStart
                };
            }
        }
    }
    return {
        wasOpen: open,
        articleId: currentArticleId,
        scrollTop: list ? Number(list.scrollTop) || 0 : 0,
        focusedItemId,
        focusKind,
        noteSelection,
        filter,
        savedOnly,
        search,
        sort,
        activeId: active?.id || '',
        activeFilter: active?.getAttribute?.('data-filter') || ''
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
        const activeTarget = snapshot.activeFilter
            ? panel.querySelector(`[data-filter="${CSS.escape(snapshot.activeFilter)}"]`)
            : (snapshot.activeId ? panel.querySelector(`#${CSS.escape(snapshot.activeId)}`) : null);
        (activeTarget || panel.querySelector('.reading-panel-close'))?.focus({ preventScroll: true });
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
    // 筆記輸入中的游標／選取也要還原；只 focus 會把 caret 推到結尾。
    if (snapshot.focusKind === 'note' && snapshot.noteSelection && typeof target.setSelectionRange === 'function') {
        try {
            target.setSelectionRange(
                Math.max(0, Number(snapshot.noteSelection.start) || 0),
                Math.max(0, Number(snapshot.noteSelection.end) || 0)
            );
        } catch (_) { /* noop */ }
    }
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

function filterLabels() {
    return {
        all: t('article.readingFilterAll'), words: t('article.readingFilterWords'),
        sentences: t('article.readingFilterSentences'), marked: t('article.readingFilterMarked'),
        notes: t('article.readingFilterNotes'), ai: t('article.readingFilterAi')
    };
}

function panelRecords() {
    return selectReadingRecords({
        items: readingStore.listLearningItems(currentArticleId),
        documents: readingStore.listArticleDocuments(currentArticleId, { withContent: true }),
        filter, savedOnly, query: search, sort, isSaved: readingStore.isItemSaved
    });
}

function renderFilters(view) {
    panel.querySelectorAll('[data-filter]').forEach(button => {
        const active = filter === button.dataset.filter;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
        button.querySelector('.reading-filter-count').textContent = loadState === 'ready' ? String(view.counts[button.dataset.filter]) : '—';
    });
    panel.querySelector('#reading-saved-only').checked = savedOnly;
    const searchInput = panel.querySelector('#reading-search');
    if (searchInput.value !== search) searchInput.value = search;
    panel.querySelector('#reading-sort').value = sort;
    panel.querySelector('#reading-results').textContent = loadState === 'ready'
        ? t('article.readingResults', { count: view.records.length, total: view.total }) : '';
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

function itemCardHtml(item) {
    const saved = readingStore.isItemSaved(item.id);
    const links = readingStore.listVocabularyLinks({ itemId: item.id });
    const books = [...new Set(links.map(link => readingStore.getVocabularyBook(link.bookId)?.name).filter(Boolean))];
    const draft = noteDrafts.get(item.id);
    const note = draft ? draft.value : (item.note || '');
    const quote = item.anchor?.quote || '';
    const expanded = expandedItems.has(item.id);
    const uncertain = item.positionUncertain || Number(item.anchor?.start) < 0;
    const time = sort === 'updated' ? item.updatedAt : item.lastViewedAt;
    return `
      <article class="reading-item ${item.marked ? 'is-marked' : ''}" role="listitem" data-item-id="${escapeHtml(item.id)}" aria-labelledby="reading-title-${escapeHtml(item.id)}">
        <div class="reading-item-head"><span class="reading-kind">${kindLabel(item.kind)}</span>
          ${saved ? `<span class="reading-saved-badge" title="${escapeHtml(books.join(' / '))}">★ ${t('article.readingSavedShort')}</span>` : ''}
          ${uncertain ? `<span class="reading-meta is-warning">${t('article.readingPositionUncertainShort')}</span>` : ''}
          ${time ? `<time class="reading-item-time" datetime="${escapeHtml(time)}" title="${escapeHtml(formatDateTime(time))}">${escapeHtml(formatDateTime(time, { month: 'numeric', day: 'numeric' }))}</time>` : ''}
        </div>
        <h4 class="reading-quote" id="reading-title-${escapeHtml(item.id)}">${escapeHtml(quote)}</h4>
        <div class="reading-meaning ${meaningOf(item) ? '' : 'is-muted'}">${escapeHtml(meaningOf(item)) || t('article.readingNoExplanation')}</div>
        ${note && !expanded ? `<div class="reading-note-preview">${escapeHtml(note)}</div>` : ''}
        <div class="reading-quick-actions">
          <button type="button" class="btn tertiary" data-action="locate">${t('article.readingLocate')}</button>
          <button type="button" class="reading-mark-toggle ${item.marked ? 'is-active' : ''}" data-mark-toggle="1" aria-pressed="${item.marked === true}" aria-label="${escapeHtml(t('article.markToggleAria', { quote }))}">${markButtonLabel(item.marked)}</button>
          <button type="button" class="btn tertiary" data-action="expand" aria-expanded="${expanded}" aria-controls="reading-detail-${escapeHtml(item.id)}">${expanded ? t('article.readingCollapse') : note ? t('article.readingEditNote') : t('article.readingExpand')}</button>
        </div>
        <div id="reading-detail-${escapeHtml(item.id)}" class="reading-item-detail ${expanded ? '' : 'hidden'}">
          ${item.sentence && item.sentence !== quote ? `<div class="reading-sentence">${escapeHtml(item.sentence)}</div>` : ''}
          ${saved && books.length ? `<div class="reading-sentence">${t('article.readingSavedToBook')}: ${escapeHtml(books.join(' / '))}</div>` : ''}
          <label class="reading-note-label" for="reading-note-${escapeHtml(item.id)}">${t('article.readingNote')}</label>
          <textarea id="reading-note-${escapeHtml(item.id)}" class="reading-note" rows="2" maxlength="20000" data-note-id="${escapeHtml(item.id)}" placeholder="${t('article.readingNotePlaceholder')}">${escapeHtml(note)}</textarea>
          <div class="reading-note-status" data-note-status="${escapeHtml(item.id)}" role="status">${draft?.status === 'error' ? t('article.saveFailedRetry') : draft?.status === 'saving' ? t('article.readingSaving') : draft?.status === 'saved' ? t('article.readingSaved') : ''}</div>
          <div class="reading-item-actions">
            ${!saved ? `<button type="button" class="btn tertiary" data-action="add-book">${t('article.readingAddToBook')}</button>` : ''}
            <button type="button" class="btn tertiary" data-action="ask">${t('article.askAi')}</button>
            ${uncertain ? `<button type="button" class="btn tertiary" data-action="reanchor">${t('article.readingReanchor')}</button>` : ''}
            <button type="button" class="btn tertiary" data-action="copy">${t('article.readingCopyQuote')}</button>
            <button type="button" class="btn tertiary reading-delete" data-action="delete" aria-label="${escapeHtml(t('article.readingDeleteAria', { quote }))}">${t('article.delete')}</button>
          </div>
        </div>
      </article>`;
}

function documentCardHtml(doc) {
    const sources = (doc.sourceItemIds || []).map(id => readingStore.getLearningItem(id)).filter(item => item && !item.deletedAt);
    const sourceCount = (doc.sourceItemIds || []).length;
    return `
      <article class="reading-doc" role="listitem" data-doc-id="${escapeHtml(doc.id)}" aria-labelledby="reading-title-${escapeHtml(doc.id)}">
        <div class="reading-item-head"><span class="reading-kind">${doc.kind === 'ai' ? t('article.readingFilterAi') : t('article.readingArticleNote')}</span>
          <time class="reading-item-time" datetime="${escapeHtml(doc.updatedAt)}">${escapeHtml(formatDateTime(doc.updatedAt))}</time>
        </div>
        <h4 class="reading-quote" id="reading-title-${escapeHtml(doc.id)}">${escapeHtml(doc.title || '')}</h4>
        <div class="reading-doc-preview">${escapeHtml(String(doc.content || '').replace(/[#*`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 150))}</div>
        <details data-doc-details="${escapeHtml(doc.id)}"><summary>${t('article.readingShowContent')}</summary>
          <div class="reading-doc-content">${markdownToHtml(doc.content || '')}</div>
          ${sourceCount ? `<div class="reading-doc-sources">${t('article.readingSources', { count: sourceCount })}${sources.map(item => `<button type="button" class="btn tertiary" data-source-item="${escapeHtml(item.id)}">${escapeHtml(item.anchor?.quote)}</button>`).join('')}${sources.length < sourceCount ? `<span>${t('article.readingSourceUnavailable')}</span>` : ''}</div>` : ''}
          ${(doc.sourceMessageIds || []).length ? `<button type="button" class="btn tertiary" data-doc-action="conversation">${t('article.readingSourceConversation')}</button>` : ''}
          <div class="reading-item-actions"><button type="button" class="btn tertiary reading-delete" data-doc-action="delete" aria-label="${escapeHtml(t('article.readingDeleteAria', { quote: doc.title || '' }))}">${t('article.delete')}</button></div>
        </details>
      </article>`;
}

function renderList(view) {
    const list = panel.querySelector('#reading-panel-list');
    const snapshot = capturePanelState();
    const active = document.activeElement;
    const activeCard = active?.closest?.('[data-item-id], [data-doc-id]');
    const action = active?.getAttribute?.('data-action') || (active?.hasAttribute?.('data-mark-toggle') ? 'mark' : '');
    const openDocs = [...list.querySelectorAll('details[open][data-doc-details]')].map(element => element.dataset.docDetails);
    list.setAttribute('aria-busy', String(loadState === 'loading'));
    if (loadState === 'loading') {
        list.innerHTML = `<div class="reading-empty" role="status">${t('article.readingLoading')}</div>`;
    } else if (loadState === 'error') {
        list.innerHTML = `<div class="reading-empty" role="alert"><p>${t('article.readingLoadFailed')}</p><button type="button" class="btn secondary" id="reading-load-retry">${t('article.retry')}</button></div>`;
        list.querySelector('#reading-load-retry').addEventListener('click', () => readPanelArticle(currentArticleId));
    } else if (!view.records.length) {
        list.innerHTML = `<div class="reading-empty"><p>${t(view.total ? 'article.readingFilteredEmpty' : 'article.readingEmpty')}</p>${view.total ? `<button type="button" class="btn secondary" id="reading-clear-filters">${t('article.readingClearFilters')}</button>` : ''}</div>`;
        list.querySelector('#reading-clear-filters')?.addEventListener('click', () => {
            filter = 'all'; savedOnly = false; search = '';
            renderPanel();
            panel.querySelector('#reading-search').focus();
        });
    } else {
        list.innerHTML = view.records.map(record => record.type === 'item' ? itemCardHtml(record.entity) : documentCardHtml(record.entity)).join('');
        for (const id of openDocs) list.querySelector(`[data-doc-details="${CSS.escape(id)}"]`)?.setAttribute('open', '');
        wireItemActions();
    }
    list.scrollTop = snapshot.scrollTop;
    if (activeCard && snapshot.focusedItemId) {
        const card = list.querySelector(`[data-item-id="${CSS.escape(snapshot.focusedItemId)}"]`);
        const target = action === 'mark' ? card?.querySelector('[data-mark-toggle]')
            : action ? card?.querySelector(`[data-action="${action}"]`) : card?.querySelector('[data-action="expand"]');
        (target || panel.querySelector('.reading-panel-close'))?.focus({ preventScroll: true });
    }
}

async function persistNoteDraft(itemId, textarea) {
    const draft = noteDrafts.get(itemId);
    if (!draft) return { ok: true, skipped: true };
    if (draft.promise) {
        await draft.promise;
        return persistNoteDraft(itemId, textarea);
    }
    if (draft.status === 'saved') return { ok: true };
    const value = draft.value;
    clearTimeout(draft.timer);
    draft.timer = null;
    draft.status = 'saving';
    let statusEl = panel?.querySelector(`[data-note-status="${CSS.escape(itemId)}"]`);
    if (statusEl) statusEl.textContent = t('article.readingSaving');
    const latest = readingStore.getLearningItem(itemId);
    if (!latest) {
        draft.status = 'error';
        if (statusEl) statusEl.textContent = t('article.saveFailedRetry');
        return { ok: false, error: 'not_found' };
    }
    draft.promise = readingActions.saveNote(itemId, value, draft.actionContext || null).catch(() => ({ ok: false }));
    const result = await draft.promise;
    draft.promise = null;
    if (draft.value !== value) return persistNoteDraft(itemId, textarea);
    draft.status = result.ok ? 'saved' : 'error';
    // store 的 change 事件可能已重建卡片，不能寫回 await 前已卸載的節點。
    statusEl = panel?.querySelector(`[data-note-status="${CSS.escape(itemId)}"]`);
    if (statusEl) {
        statusEl.innerHTML = result.ok
            ? t('article.readingSaved')
            : `${t('article.saveFailedRetry')} <button type="button" class="link-btn" data-note-retry="${escapeHtml(itemId)}">${t('article.retry')}</button>`;
        if (!result.ok) {
            statusEl.querySelector('[data-note-retry]')?.addEventListener('click', () => {
                const area = panel?.querySelector(`[data-note-id="${CSS.escape(itemId)}"]`);
                if (area) {
                    draft.value = area.value;
                    area.focus({ preventScroll: true });
                    persistNoteDraft(itemId, area);
                }
            });
        }
    }
    if (result.ok) {
        setTimeout(() => { if (noteDrafts.get(itemId) === draft && draft.status === 'saved') noteDrafts.delete(itemId); }, 1200);
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

async function runExportChoice({ articleId, context, fullText = false, chat = false, fullBackup = false }) {
    if (!readingStore.isReadingContextActive(context)) return { ok: false, error: 'stale_scope' };
    // 匯出前先 flush 面板與片語草稿（沿用既有邏輯）；任何一筆失敗都不匯出。
    const panelFlushed = await flushNoteDrafts();
    const pickerFlushed = await flushPhrasePickerNote();
    if (!panelFlushed || !pickerFlushed || pickerFlushed.ok === false) {
        ui.displayMessage(t('article.saveFailedRetry'), 'error');
        return { ok: false, error: 'note_save_failed' };
    }
    if (currentArticleId !== articleId || !readingStore.isReadingContextActive(context)) {
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

function openExportDialog({ source = 'panel', fullBackup = false } = {}) {
    const articleId = currentArticleId;
    const context = readingStore.captureReadingContext();
    if (!articleId) {
        ui.displayMessage(t('article.readingNoArticle'), 'warning');
        return Promise.resolve({ ok: false, error: 'no_article' });
    }
    return readingExport.describeReadingScope(articleId).then((scope) => {
        if (!scope || scope.ok === false) {
            ui.displayMessage(t('article.readingExportFailed'), 'error');
            return { ok: false, error: (scope && scope.error) || 'scope_failed' };
        }
        if (currentArticleId !== articleId || !readingStore.isReadingContextActive(context)) {
            // 讀取摘要期間已切文章／帳戶：不開對話框，避免匯出到別的 scope。
            ui.displayMessage(t('article.readingExportFailed'), 'error');
            return { ok: false, error: 'stale_scope' };
        }
        const initial = { fullText: !!exportSelection.fullText, chat: !!exportSelection.chat, fullBackup };
        return new Promise((resolve) => {
            const overlay = ui.showOptionsModal({
                title: t('article.exportScopeTitle'),
                description: exportScopeDescription(scope, initial),
                options: [
                    { type: 'checkbox', key: 'fullText', label: t('article.exportIncludeFullText'), default: initial.fullText },
                    { type: 'checkbox', key: 'chat', label: t('article.exportIncludeChat'), default: initial.chat },
                    { type: 'checkbox', key: 'fullBackup', label: t('article.exportFullBackup'), default: initial.fullBackup }
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
                    runExportChoice({ articleId, context, ...choice, source })
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

function renderUndo() {
    const box = panel.querySelector('#reading-undo');
    const active = undoState && undoState.articleId === currentArticleId && readingStore.isReadingContextActive(undoState.context);
    box.classList.toggle('hidden', !active);
    if (!active) { box.innerHTML = ''; return; }
    box.innerHTML = `<span>${escapeHtml(t('article.readingDeleted', { quote: undoState.title }))}</span><button type="button" class="btn tertiary" id="reading-undo-delete">${t('article.undo')}</button>`;
    box.querySelector('button').addEventListener('click', async event => {
        const pending = undoState;
        if (!pending || !readingStore.isReadingContextActive(pending.context) || pending.articleId !== currentArticleId) return;
        event.currentTarget.disabled = true;
        const result = pending.type === 'item'
            ? await readingStore.restoreLearningItem(pending.id, pending.deletedAt)
            : await readingStore.restoreArticleDocument(pending.id, pending.deletedAt);
        if (undoState !== pending) return;
        if (!result.ok) {
            ui.displayMessage(t('article.readingRestoreFailed'), 'error');
            renderUndo();
            return;
        }
        undoState = null;
        renderPanel();
        const restored = pending.type === 'item'
            ? panel.querySelector(`[data-item-id="${CSS.escape(pending.id)}"] [data-action="expand"]`)
            : panel.querySelector(`[data-doc-id="${CSS.escape(pending.id)}"] summary`);
        (restored || panel.querySelector('.reading-panel-close'))?.focus({ preventScroll: true });
        ui.displayMessage(t('article.readingRestored'), 'success');
    });
}

async function deleteRecord(type, entity) {
    const context = readingStore.captureReadingContext();
    const articleId = currentArticleId;
    const title = entity.anchor?.quote || entity.title || '';
    const ok = await ui.confirmAction({
        title: t('article.readingDeleteTitle'),
        message: type === 'item' ? t('article.readingDeleteMessage') : t('article.readingDeleteDocument', { title }),
        confirmLabel: t('article.delete'), cancelLabel: t('common.cancel'), danger: true
    });
    if (!ok || !readingStore.isReadingContextActive(context) || currentArticleId !== articleId) return;
    if (type === 'item' && !await flushNoteDrafts()) {
        ui.displayMessage(t('article.saveFailedRetry'), 'error');
        return;
    }
    if (!readingStore.isReadingContextActive(context) || currentArticleId !== articleId) return;
    const result = type === 'item' ? await readingStore.deleteLearningItem(entity.id) : await readingStore.deleteArticleDocument(entity.id);
    if (!readingStore.isReadingContextActive(context) || currentArticleId !== articleId) return;
    if (!result?.ok) {
        ui.displayMessage(t('article.readingDeleteFailed'), 'error');
        return;
    }
    noteDrafts.delete(entity.id);
    expandedItems.delete(entity.id);
    undoState = { type, id: entity.id, title, articleId, context, deletedAt: result.entity.deletedAt };
    renderPanel();
    panel.querySelector('#reading-undo-delete')?.focus({ preventScroll: true });
}

async function openSourceConversation(doc) {
    if (!window.__assistant?.__ready) {
        ui.displayMessage(t('assistant.unavailable'), 'warning');
        return;
    }
    const articleId = currentArticleId;
    const context = readingStore.captureReadingContext();
    let source = null;
    for (const conversation of readingStore.listConversations(articleId)) {
        const messages = await readingStore.getMessages(conversation.id);
        if (messages.some(message => doc.sourceMessageIds.includes(message.id))) { source = conversation; break; }
    }
    if (currentArticleId !== articleId || !readingStore.isReadingContextActive(context)) return;
    if (!source) { ui.displayMessage(t('article.readingSourceUnavailable'), 'warning'); return; }
    const closed = await closePanel();
    if (!closed.ok || currentArticleId !== articleId || !readingStore.isReadingContextActive(context)) return;
    window.__assistant.open();
    const switched = await window.__assistant.switch(articleId, source.id);
    if (switched === false) ui.displayMessage(t('article.readingAssistantBusy'), 'warning');
}

function wireItemActions() {
    panel.querySelectorAll('[data-mark-toggle]').forEach(button => {
        button.addEventListener('click', async () => {
            const item = readingStore.getLearningItem(button.closest('.reading-item').dataset.itemId);
            if (!item) return;
            button.disabled = true;
            const result = await readingActions.setMarked(item.id, item.marked !== true, readingActions.captureActionContext());
            if (!result.ok) {
                ui.displayMessage(t('article.saveFailedRetry'), 'error');
                button.disabled = false;
            } else renderPanel();
        });
    });
    panel.querySelectorAll('.reading-note').forEach(textarea => {
        const itemId = textarea.dataset.noteId;
        textarea.addEventListener('input', () => {
            const draft = noteDrafts.get(itemId) || { value: '', status: '', timer: null, actionContext: readingActions.captureActionContext() };
            draft.value = textarea.value;
            draft.status = 'saving';
            clearTimeout(draft.timer);
            const status = panel.querySelector(`[data-note-status="${CSS.escape(itemId)}"]`);
            if (status) status.textContent = t('article.readingSaving');
            draft.timer = setTimeout(() => persistNoteDraft(itemId, textarea), 500);
            noteDrafts.set(itemId, draft);
        });
        textarea.addEventListener('blur', event => {
            // 重試鈕的 click 會保存並還焦點；blur 不得先重繪並移除正被點擊的按鈕。
            if (event.relatedTarget?.getAttribute?.('data-note-retry') === itemId) return;
            persistNoteDraft(itemId, textarea);
        });
    });
    panel.querySelectorAll('[data-action]').forEach(button => {
        button.addEventListener('click', async () => {
            const card = button.closest('.reading-item');
            const id = card.dataset.itemId;
            const item = readingStore.getLearningItem(id);
            if (!item) return;
            const action = button.dataset.action;
            if (action === 'expand') {
                if (expandedItems.has(id)) {
                    if (noteDrafts.has(id) && !(await persistNoteDraft(id)).ok) return;
                    expandedItems.delete(id);
                } else expandedItems.add(id);
                renderPanel();
                return;
            }
            if (action === 'locate') { await locateItem(item); return; }
            if (action === 'copy') {
                try {
                    await navigator.clipboard.writeText(item.anchor?.quote || '');
                    ui.displayMessage(t('article.readingCopied'), 'success');
                } catch (_) { ui.displayMessage(t('article.readingCopyFailed'), 'error'); }
                return;
            }
            if (action === 'reanchor') {
                const located = readingActions.resolveAnchor(item.articleId, item.anchor?.quote || '', item.sentence || '');
                if (located.start < 0) { ui.displayMessage(t('article.readingLocateFailed'), 'warning'); return; }
                const result = await readingStore.updateLearningItemPosition(id, { anchor: located, sentence: item.sentence, contentVersion: readingActions.articleVersion(item.articleId), positionUncertain: false });
                if (!result.ok) ui.displayMessage(t('article.saveFailedRetry'), 'error');
                else renderPanel();
                return;
            }
            if (action === 'ask') {
                if (!window.__assistant?.__ready) { ui.displayMessage(t('assistant.unavailable'), 'warning'); return; }
                const closed = await closePanel();
                if (!closed.ok) return;
                window.__assistant.compose({ text: t('article.askAiReference', { quote: item.anchor?.quote || '' }), context: {
                    learningItemId: item.id, anchor: item.anchor, contentVersion: item.contentVersion, articleId: item.articleId
                } });
                return;
            }
            if (action === 'delete') { await deleteRecord('item', item); return; }
            if (action === 'add-book') {
                button.disabled = true;
                try {
                    const result = await readingActions.addItemToVocabulary(item, { context: item.sentence });
                    if (!result || result.ok === false) throw new Error(result?.error || 'failed');
                    ui.displayMessage(t('article.readingAddedToBook'), 'success');
                    renderPanel();
                } catch (_) {
                    ui.displayMessage(t('article.saveFailedRetry'), 'error');
                    button.disabled = false;
                }
            }
        });
    });
    panel.querySelectorAll('[data-source-item]').forEach(button => button.addEventListener('click', () => openReadingPanelForItem(currentArticleId, button.dataset.sourceItem)));
    panel.querySelectorAll('[data-doc-action]').forEach(button => button.addEventListener('click', async () => {
        const doc = readingStore.getArticleDocument(button.closest('.reading-doc').dataset.docId);
        if (!doc) return;
        if (button.dataset.docAction === 'conversation') await openSourceConversation(doc);
        else await deleteRecord('document', doc);
    }));
}

async function locateItem(item) {
    const candidates = Array.from(document.querySelectorAll('.interactive-sentence')).map(element => ({
        element, text: (element.getAttribute('data-sentence') || element.textContent || '').trim()
    }));
    for (const entry of candidates) entry.start = sourceStartForSentence(entry.element, currentArticleId, candidates);
    const target = sourceSentenceForItem(item, candidates)?.element;
    if (!target) { ui.displayMessage(t('article.readingLocateFailed'), 'warning'); return; }
    if (isModalPanel()) {
        const snapshot = capturePanelState();
        snapshot.focusedItemId = item.id;
        snapshot.focusKind = 'item';
        const closed = await closePanel();
        if (!closed.ok) return;
        returnState = snapshot;
        document.getElementById('reading-return')?.classList.remove('hidden');
    } else if (!await flushNoteDrafts()) return;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.classList.add('reading-locate-flash');
    setTimeout(() => target.classList.remove('reading-locate-flash'), 1600);
}

function openArticleNoteDialog() {
    if (!currentArticleId) {
        ui.displayMessage(t('article.readingNoArticle'), 'warning');
        return;
    }
    const articleId = currentArticleId;
    const actionContext = readingStore.captureReadingContext();
    const existing = readingStore.listArticleDocuments(articleId, { withContent: true })
        .find(doc => doc.kind === 'note');
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
        if (articleId !== currentArticleId || !readingStore.isReadingContextActive(actionContext)) {
            status.textContent = t('article.saveFailedRetry');
            return;
        }
        button.disabled = true;
        status.textContent = t('article.readingSaving');
        const result = await readingStore.saveArticleDocument({
            id: existing?.id || '',
            articleId,
            kind: 'note',
            title: t('article.readingArticleNoteTitle'),
            content,
            contentVersion: readingActions.articleVersion(articleId),
            sourceItemIds: [],
            sourceMessageIds: []
        });
        if (!button.isConnected || currentArticleId !== articleId || !readingStore.isReadingContextActive(actionContext)) return;
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
    const articleId = currentArticleId;
    const context = readingStore.captureReadingContext();
    const items = readingStore.listLearningItems(articleId).filter((item) => !item.deletedAt);
    const docs = readingStore.listArticleDocuments(articleId).filter((doc) => doc.kind === 'ai');
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
        if (currentArticleId !== articleId || !readingStore.isReadingContextActive(context)) {
            status.textContent = t('article.aiGenerateFailed');
            return;
        }
        button.disabled = true;
        status.textContent = t('article.aiGenerating');
        try {
            const result = await readingActions.generateReadingDocument({
                articleId,
                mode,
                itemIds,
                documentIds,
                includeNotes
            });
            if (!button.isConnected || currentArticleId !== articleId || !readingStore.isReadingContextActive(context)) return;
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
            if (!button.isConnected) return;
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
        if (currentArticleId !== articleId) return;
        if (!readingStore.isReadingContextActive(ctx)) return;
        loadState = loaded?.ok ? 'ready' : 'error';
        applyCurrentReadingState();
    }).catch(() => {});
}

function renderPanel() {
    if (!panel) return;
    // 正在輸入筆記時不整份重繪，避免遠端同步把草稿蓋掉或游標跳走。
    const active = document.activeElement;
    if (active && active.classList && active.classList.contains('reading-note')) return;
    const items = readingStore.listLearningItems(currentArticleId).filter(item => !item.deletedAt);
    const docs = readingStore.listArticleDocuments(currentArticleId);
    const view = panelRecords();
    panel.querySelector('#reading-panel-sub').textContent = loadState === 'ready'
        ? t('article.readingPanelSub', { items: items.length, notes: docs.filter(doc => doc.kind === 'note').length, docs: docs.filter(doc => doc.kind === 'ai').length })
        : t(loadState === 'loading' ? 'article.readingLoading' : 'article.readingLoadFailed');
    panel.querySelector('#reading-panel-status').innerHTML = statusHtml();
    wireConflictButtons();
    renderFilters(view);
    renderList(view);
    renderUndo();
    if (dom.articleReadingCount && loadState === 'ready') {
        dom.articleReadingCount.textContent = String(view.total);
        dom.articleReadingCount.classList.toggle('hidden', view.total === 0);
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
        search = '';
        expandedItems.add(itemId);
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
    if (previousArticleId !== currentArticleId) {
        filter = 'all'; savedOnly = false; search = ''; sort = 'source';
        expandedItems.clear(); undoState = null; returnState = null;
        document.getElementById('reading-return')?.classList.add('hidden');
    }
    if (!articleId && draftsFlushed) noteDrafts.clear();
    if (!currentArticleId) {
        if (panel) panel.classList.add('hidden');
        document.body.classList.remove('reading-panel-open');
        syncPanelLayout();
        clearMarks();
        if (dom.articleReadingCount) dom.articleReadingCount.classList.add('hidden');
        return;
    }
    // 啟動與換文章只讀這篇的條目／文件；讀取期間若又切換文章則放棄舊結果。
    await readPanelArticle(articleId);
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
            + readingStore.listArticleDocuments(currentArticleId).length;
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
        search = snapshot.search;
        sort = snapshot.sort;
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
