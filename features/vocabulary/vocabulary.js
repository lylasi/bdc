import * as state from '../../modules/state.js';
import * as dom from '../../modules/dom.js';
import * as storage from '../../modules/storage.js';
import * as ui from '../../modules/ui.js';
import { escapeHtml, escapeAttr, tHtml } from '../../modules/ui.js';
import * as api from '../../modules/api.js';
import * as audio from '../../modules/audio.js';
import { t } from '../../modules/i18n.js';
import { loadGlobalSettings } from '../../modules/settings.js';
import { openPhonetics } from '../phonetics/phonetics.js';
// 提供登入入口（已登入的使用者可直接同步雲端單詞本）
import { openLoginModal as openSyncLoginModal } from '../sync/sync.js';

// =================================
// Vocabulary Feature
// =================================

// 原生 alert/confirm 在部分環境（內嵌瀏覽器、被瀏覽器封鎖的對話框）不會顯示，
// 這裡統一改用站內提示與站內確認彈窗。
function notify(message, type = 'info', duration = 3600) {
    ui.displayMessage(message, type, duration);
}

function askConfirm({ title = '', message = '', confirmLabel = '', cancelLabel = '', danger = false } = {}) {
    return ui.confirmAction({ title, message, confirmLabel, cancelLabel, danger });
}

/**
 * 初始化单词本功能，绑定所有相关的事件监听器。
 */
export function initVocabulary() {
    dom.addVocabBookBtn.addEventListener('click', () => openModalForNewBook());
    dom.vocabBookList.addEventListener('click', handleVocabBookSelection);
    dom.editVocabBookBtn.addEventListener('click', () => openModalForEditBook());
    dom.deleteVocabBookBtn.addEventListener('click', deleteActiveVocabBook);
    dom.importVocabBookBtn.addEventListener('click', openModalForImportBook);
    dom.exportVocabBookBtn.addEventListener('click', exportActiveVocabBook);
    dom.mergeVocabBooksBtn.addEventListener('click', openModalForMergeBooks);
    if (dom.completeMissingBtn) dom.completeMissingBtn.addEventListener('click', openModalForCompleteMissing);
    initWordPanelMoreMenu();
    if (dom.wordFilter) {
        dom.wordFilter.addEventListener('input', renderWordList);
    }

    // 單詞列表高亮
    dom.wordList.addEventListener('mouseover', (e) => {
        const wordId = e.target.dataset.wordId;
        if (wordId) {
            const elements = dom.wordList.querySelectorAll(`[data-word-id="${wordId}"]`);
            elements.forEach(el => el.classList.add('highlight'));
        }
    });

    dom.wordList.addEventListener('mouseout', (e) => {
        const wordId = e.target.dataset.wordId;
        if (wordId) {
            const elements = dom.wordList.querySelectorAll(`[data-word-id="${wordId}"]`);
            elements.forEach(el => el.classList.remove('highlight'));
        }
    });

    // 初次加載時渲染視圖
    renderVocabBookList();
    updateActiveBookView();
    document.addEventListener('bdc:locale-change', refreshVocabularyView);
    document.addEventListener('bdc:settings-change', renderWordList);
    window.addEventListener('storage', event => {
        if (event.key === 'pen_global_settings') renderWordList();
    });

    // 首次啟動且沒有任何單詞本時，提醒用戶導入
    try {
        const shown = localStorage.getItem('vocabImportPromptShown') === '1';
        if (state.vocabularyBooks.length === 0 && !shown) {
            showNoBookOnboarding();
            localStorage.setItem('vocabImportPromptShown', '1');
        }
    } catch (_) { /* 忽略存取錯誤 */ }
}

// 外部可呼叫：在導航切換回單詞本頁時刷新視圖
export function refreshVocabularyView() {
    try {
        renderVocabBookList();
        updateActiveBookView();
    } catch (e) {
        console.warn('刷新單詞本視圖失敗:', e);
    }
}

// =================================
// 手機版：單詞本操作收進「更多」選單
// （桌面仍顯示原本的 chips；選單項目由實際按鈕生成，事件與禁用狀態只有一份來源）
// =================================
let wordPanelMenuEl = null;
let wordPanelMoreBtnEl = null;
let wordPanelMenuSources = [];

function buildWordPanelMenuItem(sourceBtn) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'menu-item';
    item.setAttribute('role', 'menuitem');
    if (sourceBtn.id === 'delete-vocab-book-btn') item.classList.add('danger');

    const icon = sourceBtn.querySelector('.icon');
    if (icon) item.appendChild(icon.cloneNode(true));

    const label = sourceBtn.querySelector('span[data-i18n]');
    const text = document.createElement('span');
    if (label?.dataset.i18n) text.dataset.i18n = label.dataset.i18n; // 語言切換時一起更新
    text.textContent = label ? label.textContent : (sourceBtn.title || '');
    item.appendChild(text);

    item.addEventListener('click', () => {
        closeWordPanelMenu();
        if (!sourceBtn.disabled) sourceBtn.click();
    });
    return item;
}

function syncWordPanelMenuState() {
    if (!wordPanelMenuEl) return;
    wordPanelMenuEl.querySelectorAll('.menu-item').forEach((item, index) => {
        const source = wordPanelMenuSources[index];
        if (source) item.disabled = !!source.disabled;
    });
}

function handleWordPanelMenuOutside(event) {
    if (wordPanelMenuEl?.contains(event.target)) return;
    if (wordPanelMoreBtnEl?.contains(event.target)) return;
    closeWordPanelMenu();
}

function handleWordPanelMenuKeydown(event) {
    if (event.key !== 'Escape') return;
    closeWordPanelMenu();
    wordPanelMoreBtnEl?.focus();
}

function openWordPanelMenu() {
    if (!wordPanelMenuEl) return;
    syncWordPanelMenuState();
    wordPanelMenuEl.hidden = false;
    wordPanelMoreBtnEl?.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', handleWordPanelMenuOutside, true);
    document.addEventListener('keydown', handleWordPanelMenuKeydown);
}

function closeWordPanelMenu() {
    if (!wordPanelMenuEl || wordPanelMenuEl.hidden) return;
    wordPanelMenuEl.hidden = true;
    wordPanelMoreBtnEl?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', handleWordPanelMenuOutside, true);
    document.removeEventListener('keydown', handleWordPanelMenuKeydown);
}

function initWordPanelMoreMenu() {
    const panel = document.getElementById('vocab-words-panel');
    wordPanelMoreBtnEl = document.getElementById('word-panel-more-btn');
    if (!panel || !wordPanelMoreBtnEl) return;

    wordPanelMenuSources = [
        dom.completeMissingBtn,
        dom.mergeVocabBooksBtn,
        dom.exportVocabBookBtn,
        dom.editVocabBookBtn,
        dom.deleteVocabBookBtn
    ].filter(Boolean);

    wordPanelMenuEl = document.createElement('div');
    wordPanelMenuEl.id = 'word-panel-menu';
    wordPanelMenuEl.className = 'word-panel-menu';
    wordPanelMenuEl.hidden = true;
    wordPanelMenuEl.setAttribute('role', 'menu');

    wordPanelMenuSources.forEach((sourceBtn) => {
        // 刪除前加分隔線，降低誤觸
        if (sourceBtn.id === 'delete-vocab-book-btn') {
            const sep = document.createElement('div');
            sep.className = 'menu-sep';
            wordPanelMenuEl.appendChild(sep);
        }
        wordPanelMenuEl.appendChild(buildWordPanelMenuItem(sourceBtn));
    });

    panel.appendChild(wordPanelMenuEl);

    wordPanelMoreBtnEl.addEventListener('click', (event) => {
        event.stopPropagation();
        if (wordPanelMenuEl.hidden) openWordPanelMenu();
        else closeWordPanelMenu();
    });

    // 由手機轉回桌面（按鈕被 CSS 隱藏）時收起來，避免殘留
    window.addEventListener('resize', () => {
        if (window.getComputedStyle(wordPanelMoreBtnEl).display === 'none') closeWordPanelMenu();
    });
}

export async function handleVocabularyQueryParams() {
    const params = new URLSearchParams(window.location.search);
    const manifestId = params.get('wordlist') || params.get('wordlistId');
    const urlParam = params.get('wordlistUrl') || params.get('wordlistURL');

    const sources = [];

    if (manifestId) {
        try {
            const defaultBooks = await fetchDefaultWordlists();
            const matchedBook = defaultBooks.find(book => book.id === manifestId);

            if (!matchedBook) {
                notify(t('vocabulary.presetNotFound', { id: manifestId }), 'warning');
            } else if (await askConfirm({
                title: t('vocabulary.importSet'),
                message: t('vocabulary.importDetectedParam', { name: matchedBook.name })
            })) {
                sources.push({ type: 'preset', value: matchedBook.path, name: matchedBook.name });
            }
        } catch (error) {
            console.error('加載預設單詞本清單失敗:', error);
            notify(t('vocabulary.loadPresetListFailed'), 'error');
        }
    }

    if (urlParam) {
        try {
            const resolvedUrl = new URL(urlParam, window.location.href).toString();
            const urlDisplayName = new URL(resolvedUrl).pathname.split('/').pop() || t('vocabulary.urlBook');
            if (await askConfirm({
                title: t('vocabulary.importSet'),
                message: t('vocabulary.importDetectedUrl', { url: resolvedUrl })
            })) {
                sources.push({ type: 'url', value: resolvedUrl, name: urlDisplayName });
            }
        } catch (error) {
            console.error('wordlistUrl 參數無效:', error);
            notify(t('vocabulary.invalidUrlParam', { url: urlParam }), 'warning');
        }
    }

    if (sources.length === 0) {
        return;
    }

    const { summary } = await importVocabularySources(sources, {
        onStatus: (message) => console.log(`[Wordlist import] ${message}`)
    });

    if (summary.length > 0) {
        notify(t('vocabulary.importDone', { summary: summary.join('\n') }), 'success', 6000);
    } else {
        notify(t('vocabulary.noBooksImported'), 'warning');
    }
}

function renderVocabBookList() {
    dom.vocabBookList.innerHTML = '';
    if (dom.vocabBookCount) {
        dom.vocabBookCount.textContent = String(state.vocabularyBooks.length);
    }
    if (state.vocabularyBooks.length === 0) {
        // 空狀態：不要默認創建單詞本，改為顯示導入提示
        const link = `<a id="import-hint-link" href="#">${t('vocabulary.importHere')}</a>`;
        dom.vocabBookList.innerHTML = `<li class="word-item-placeholder">${t('vocabulary.noBooksImport', { link })}</li>`;
        const importLink = document.getElementById('import-hint-link');
        if (importLink) importLink.addEventListener('click', (e) => { e.preventDefault(); openModalForImportBook(); });
        return;
    }
    state.vocabularyBooks.forEach(book => {
        const li = document.createElement('li');
        li.className = 'vocab-book-item';
        li.dataset.bookId = book.id;
        li.title = book.name || '';
        if (book.id === state.activeBookId) {
            li.classList.add('active');
        }
        const count = Array.isArray(book.words) ? book.words.length : 0;
        const nameSpan = document.createElement('span');
        nameSpan.textContent = book.name;
        nameSpan.title = book.name || '';

        const countSpan = document.createElement('span');
        countSpan.className = 'word-count';
        countSpan.textContent = t('vocabulary.wordCount', { count });

        li.appendChild(nameSpan);
        li.appendChild(countSpan);
        dom.vocabBookList.appendChild(li);
    });
}

// 首次無單詞本的引導彈窗
function showNoBookOnboarding() {
    dom.modalTitle.textContent = t('vocabulary.beforeStart');
    dom.modalBody.innerHTML = `
        <div class="input-group" style="display:block;">
            <p>${t('vocabulary.onboardingEmpty')}</p>
            <p>${t('vocabulary.onboardingSuggestion')}</p>
            <p style="margin-top:8px;color:var(--ink-500);">${t('vocabulary.cloudAccountHint')}</p>
        </div>
        <div class="modal-actions">
            <button class="cancel-btn">${t('vocabulary.later')}</button>
            <button id="login-btn" class="btn-ghost">${t('vocabulary.login')}</button>
            <button class="save-btn">${t('vocabulary.importTitle')}</button>
        </div>
    `;
    const cancel = dom.appModal.querySelector('.cancel-btn');
    const save = dom.appModal.querySelector('.save-btn');
    const login = dom.appModal.querySelector('#login-btn');
    cancel.onclick = () => ui.closeModal();
    save.onclick = () => { ui.closeModal(); openModalForImportBook(); };
    login.onclick = () => { ui.closeModal(); openSyncLoginModal(); };
    ui.openModal();
}

function handleVocabBookSelection(e) {
    const target = e.target.closest('.vocab-book-item');
    if (target) {
        const bookId = target.dataset.bookId;
        if (state.activeBookId !== bookId) {
            state.setActiveBookId(bookId);
            storage.saveAppState();
            renderVocabBookList();
            updateActiveBookView();
        }
    }
}

function updateActiveBookView() {
    const activeBook = state.vocabularyBooks.find(b => b.id === state.activeBookId);
    if (activeBook) {
        dom.currentBookName.textContent = activeBook.name;
        dom.currentBookName.title = activeBook.name || '';
        dom.editVocabBookBtn.disabled = false;
        dom.deleteVocabBookBtn.disabled = false;
        dom.exportVocabBookBtn.disabled = false;
        if (dom.completeMissingBtn) dom.completeMissingBtn.disabled = (activeBook.words.length === 0);
        // 顯示當前單詞本的來源資訊（若為文章專屬生詞本，提供回到文章與原文連結）
        if (dom.currentBookMeta) {
            const isArticleBook = activeBook.sourceType === 'article' && activeBook.articleId;
            if (isArticleBook && typeof storage.getArticleMetaById === 'function') {
                let meta = null;
                try { meta = storage.getArticleMetaById(activeBook.articleId); } catch (_) {}
                const srcType = meta && meta.sourceType ? meta.sourceType : (activeBook.articleId ? 'url' : 'paste');
                const rawUrl = meta && meta.sourceUrl ? String(meta.sourceUrl) : '';

                let sourceText = t('vocabulary.sourceArticle');
                if (srcType === 'url') {
                    sourceText = t('vocabulary.sourceArticleUrl');
                } else if (srcType === 'file') {
                    sourceText = t('vocabulary.sourceArticleFile');
                } else if (srcType === 'ocr') {
                    sourceText = t('vocabulary.sourceArticleOcr');
                }

                const hasUrl = srcType === 'url' && rawUrl;
                const escUrl = hasUrl ? rawUrl.replace(/"/g, '&quot;') : '';

                dom.currentBookMeta.innerHTML = `
                    <div class="book-meta-banner">
                        <div class="book-meta-info">
                            <span class="book-meta-label">${t('vocabulary.articleSourceLabel')}</span>
                            <span class="book-meta-text">${sourceText}</span>
                        </div>
                        <div class="book-meta-actions">
                            ${hasUrl ? `<a href="${escUrl}" target="_blank" rel="noopener noreferrer" class="book-origin-link">${t('vocabulary.openOrigin')}</a>` : ''}
                            <button type="button" class="book-open-article-btn">${t('vocabulary.backToArticle')}</button>
                        </div>
                    </div>
                `;

                const openBtn = dom.currentBookMeta.querySelector('.book-open-article-btn');
                if (openBtn) {
                    openBtn.onclick = () => {
                        try {
                            if (typeof state.setCurrentArticleId === 'function') state.setCurrentArticleId(activeBook.articleId);
                            if (typeof state.setCurrentWordbookId === 'function') state.setCurrentWordbookId(activeBook.id);
                        } catch (_) {}
                        // 切換到文章詳解頁籤
                        if (dom.articleNavBtn) {
                            dom.articleNavBtn.click();
                        } else {
                            const btn = document.getElementById('article-btn');
                            if (btn) btn.click();
                        }
                    };
                }
            } else {
                dom.currentBookMeta.textContent = '';
            }
        }
        renderWordList();
    } else {
        dom.currentBookName.textContent = t('vocabulary.selectBook');
        dom.editVocabBookBtn.disabled = true;
        dom.deleteVocabBookBtn.disabled = true;
        dom.exportVocabBookBtn.disabled = true;
        if (dom.completeMissingBtn) dom.completeMissingBtn.disabled = true;
        dom.wordList.innerHTML = `<li class="word-item-placeholder">${t('vocabulary.chooseOrCreate')}</li>`;
        updateWordFilterCount(0, 0);
        if (dom.currentBookMeta) dom.currentBookMeta.textContent = '';
    }
}

async function openModalForCompleteMissing() {
    const book = state.vocabularyBooks.find(b => b.id === state.activeBookId);
    if (!book) return;

    const missing = findMissingEntries(book.words);
    dom.modalTitle.textContent = t('vocabulary.completeMissingTitle');
    dom.modalBody.innerHTML = `
        <div class="input-group" style="display:block;">
            <p>${t('vocabulary.currentBookLabel')}<strong>${escapeHtml(book.name)}</strong></p>
            <p>${t('vocabulary.missingSummary', { total: book.words.length, missing: missing.length })}</p>
            <small class="form-hint">${t('vocabulary.completeMissingHint')}</small>
        </div>
        <div id="complete-missing-progress" class="import-progress"></div>
        <div class="modal-actions">
            <button id="dedupe-words-btn" class="btn-ghost">${t('vocabulary.dedupe')}</button>
            <button class="cancel-btn">${t('common.cancel')}</button>
            <button class="save-btn" ${missing.length===0?'disabled':''}>${t('vocabulary.startAction')}</button>
        </div>
    `;
    const cancel = dom.appModal.querySelector('.cancel-btn');
    const save = dom.appModal.querySelector('.save-btn');
    const dedupe = dom.appModal.querySelector('#dedupe-words-btn');
    cancel.onclick = () => ui.closeModal();
    save.onclick = () => runCompleteMissing(book, missing);
    dedupe.onclick = () => mergeDedupeActiveBook(book);
    ui.openModal();
}

function findMissingEntries(words) {
    const isMissing = (w) => {
        const phon = (w.phonetic || '').trim().toLowerCase();
        const meaning = (w.meaning || '').trim();
        const missingPhon = !phon || phon === 'n/a' || phon === 'na';
        const missingMeaning = !meaning;
        return missingPhon || missingMeaning;
    };
    return (words || []).filter(isMissing);
}

async function runCompleteMissing(book, missingList) {
    const progress = document.getElementById('complete-missing-progress');
    if (!progress) return;
    let cancelled = false;
    const saveBtn = dom.appModal.querySelector('.save-btn');
    const cancelBtn = dom.appModal.querySelector('.cancel-btn');
    if (saveBtn) saveBtn.disabled = true;
    if (cancelBtn) cancelBtn.textContent = t('vocabulary.stopAction');
    cancelBtn.onclick = () => { cancelled = true; cancelBtn.disabled = true; };

    const { addWordToDefaultBook, ensureWordDetails } = await import('../../modules/vocab.js');

    const total = missingList.length;
    let done = 0; let updated = 0; let skipped = 0;

    const runOne = async (entry) => {
        if (cancelled) return;
        const before = { phon: entry.phonetic, meaning: entry.meaning };
        try {
            await ensureWordDetails(entry, { sentence: entry.context||'', context: entry.context||'', allowDeferForPhrase: false });
        } catch (_) {}
        const after = { phon: entry.phonetic, meaning: entry.meaning };
        if ((after.phon && after.phon !== 'n/a' && !before.phon) || (after.meaning && !before.meaning)) updated += 1; else skipped += 1;
        done += 1;
        if (progress) progress.innerHTML = `<p>${tHtml('vocabulary.completing', { word: entry.word, done, total })}</p>`;
    };

    // limit concurrency
    const CONCURRENCY = Math.min(2, total);
    let idx = 0;
    const workers = Array.from({ length: CONCURRENCY }, async () => {
        while (!cancelled && idx < total) {
            const current = missingList[idx++];
            await runOne(current);
        }
    });
    await Promise.all(workers);

    const saved = await storage.saveVocabularyBooks();
    if (!saved.ok) {
        if (progress) progress.innerHTML = `<p style="color:red;">${t('vocabulary.permanentSaveFailed', { message: saved.error || '' })}</p>`;
        return;
    }
    if (progress) progress.innerHTML = `<p style="color:green;">${t('vocabulary.completeResult', { updated, skipped })}</p>`;
    setTimeout(() => { ui.closeModal(); renderWordList(); }, 600);
}

// 合併去重：同一單詞（忽略大小寫與首尾標點、合併空白）僅保留一筆，並合併資訊
async function mergeDedupeActiveBook(book) {
    const progress = document.getElementById('complete-missing-progress');
    try {
        const { normalizeWordKey } = await import('../../modules/vocab.js');
        const map = new Map();
        const out = [];
        let removed = 0;
        const mergeInto = (dst, src) => {
            if (!dst) return src;
            // 補齊缺失欄位；音標以非 n/a 為佳
            const hasPhon = (v) => v && String(v).trim().toLowerCase() !== 'n/a';
            if (!dst.meaning && src.meaning) dst.meaning = src.meaning;
            if (!hasPhon(dst.phonetic) && hasPhon(src.phonetic)) dst.phonetic = src.phonetic;
            if (!dst.pos && src.pos) dst.pos = src.pos;
            if (!dst.context && src.context) dst.context = src.context;
            if (Array.isArray(src.examples) && src.examples.length) {
                if (!Array.isArray(dst.examples)) dst.examples = [];
                src.examples.forEach(ex => {
                    const exists = dst.examples.some(e => JSON.stringify(e) === JSON.stringify(ex));
                    if (!exists) dst.examples.push(ex);
                });
            }
            return dst;
        };
        for (const w of (book.words || [])) {
            const key = normalizeWordKey(w.word || '');
            if (!key) { out.push(w); continue; }
            if (!map.has(key)) { map.set(key, w); out.push(w); }
            else { const kept = map.get(key); mergeInto(kept, w); removed += 1; }
        }
        book.words = out;
        storage.saveVocabularyBooks();
        // 更新統計文字與按鈕狀態
        const info = dom.appModal.querySelector('.input-group');
        if (info) {
            const ps = info.querySelectorAll('p');
            if (ps[1]) {
                const missing = findMissingEntries(book.words);
                ps[1].innerHTML = t('vocabulary.missingDataSummary', { total: book.words.length, missing: missing.length });
                const startBtn = dom.appModal.querySelector('.save-btn');
                if (startBtn) startBtn.disabled = missing.length === 0;
            }
        }
        if (progress) progress.innerHTML = `<p style="color:green;">${t('vocabulary.dedupeResult', { removed })}</p>`;
        // 同步列表
        renderWordList();
    } catch (e) {
        console.warn('合併去重失敗:', e);
        if (progress) progress.innerHTML = `<p style="color:var(--danger-600);">${t('vocabulary.dedupeFailed')}</p>`;
    }
}

function openModalForNewBook() {
    dom.modalTitle.textContent = t('vocabulary.newBookTitle');
    dom.modalBody.innerHTML = `
        <div class="input-group">
            <label for="modal-book-name">${t('vocabulary.bookName')}</label>
            <input type="text" id="modal-book-name" placeholder="${t('vocabulary.bookNamePlaceholder')}">
        </div>
        <div class="input-group">
            <label for="modal-vocab-content">${t('vocabulary.bulkWords')}</label>
            <textarea id="modal-vocab-content" placeholder="${t('vocabulary.bulkWordsPlaceholder')}"></textarea>
            <div id="modal-ai-progress" class="import-progress"></div>
        </div>
        <div class="modal-actions">
            <button class="cancel-btn">${t('common.cancel')}</button>
            <button class="save-btn">${t('vocabulary.create')}</button>
        </div>
    `;
    dom.appModal.querySelector('.save-btn').onclick = () => saveBookWithAICompletion();
    dom.appModal.querySelector('.cancel-btn').onclick = ui.closeModal;
    ui.openModal();
}

function openModalForEditBook() {
    const book = state.vocabularyBooks.find(b => b.id === state.activeBookId);
    if (!book) return;

    dom.modalTitle.textContent = t('vocabulary.editBookTitle', { name: book.name });
    const isArticleBook = book.sourceType === 'article' && book.articleId;
    let sourceUrl = '';
    if (isArticleBook && typeof storage.getArticleMetaById === 'function') {
        try {
            const meta = storage.getArticleMetaById(book.articleId);
            if (meta && meta.sourceUrl) sourceUrl = String(meta.sourceUrl);
        } catch (_) { /* ignore */ }
    }
    const safeSourceUrl = sourceUrl.replace(/"/g, '&quot;');
    const wordsText = book.words.map(w => {
        const phonetic = (w.phonetic || '').replace(/^\/+|\/+$/g, '');
        return `${w.word}#${w.meaning || ''}@/${phonetic}/`;
    }).join('\n');
    dom.modalBody.innerHTML = `
        <div class="input-group">
            <label for="modal-book-name">${t('vocabulary.bookName')}</label>
            <input type="text" id="modal-book-name" value="${escapeAttr(book.name)}">
        </div>
        ${isArticleBook ? `
        <div class="input-group">
            <label for="modal-book-source-url">${t('vocabulary.sourceUrl')}</label>
            <input type="url" id="modal-book-source-url" value="${safeSourceUrl}" placeholder="https://example.com/article">
            <small class="form-hint">${t('vocabulary.sourceUrlHint')}</small>
        </div>` : ''}
        <div class="input-group">
            <label for="modal-vocab-content">${t('vocabulary.wordFormat')}</label>
            <textarea id="modal-vocab-content">${escapeHtml(wordsText)}</textarea>
            <small class="form-hint">${t('vocabulary.wordFormatHint')}</small>
            <div id="modal-ai-progress" class="import-progress"></div>
        </div>
        <div class="modal-actions">
            <button class="cancel-btn">${t('common.cancel')}</button>
            <button class="save-btn">${t('vocabulary.saveChanges')}</button>
        </div>
    `;
    dom.appModal.querySelector('.save-btn').onclick = () => saveBookWithAICompletion(book.id);
    dom.appModal.querySelector('.cancel-btn').onclick = ui.closeModal;
    ui.openModal();
}

async function openModalForImportBook() {
    dom.modalTitle.textContent = t('vocabulary.importTitle');
    dom.modalBody.innerHTML = `<p>${t('vocabulary.loadingPresets')}</p>`;
    ui.openModal();

    try {
        const defaultBooks = await fetchDefaultWordlists();
        if (defaultBooks.length === 0) {
            dom.modalBody.innerHTML = `<p>${t('vocabulary.noPresets')}</p>`;
            return;
        }

        const checkboxesHtml = defaultBooks.map(book => {
             const safeIdBase = book.id ? book.id.replace(/[^a-zA-Z0-9_-]/g, '') : book.path.replace(/[^a-zA-Z0-9]/g, '');
             const safeId = `import-checkbox-${safeIdBase || Math.random().toString(36).slice(2)}`;
             return `
                <div class="import-preset-item-wrapper">
                    <label for="${safeId}" class="import-preset-item">
                        <input type="checkbox" id="${safeId}" value="${escapeAttr(book.path)}" data-name="${escapeAttr(book.name)}" data-id="${escapeAttr(book.id || '')}" class="import-checkbox">
                        <span class="import-preset-name">${escapeHtml(book.name)}</span>
                    </label>
                </div>
            `;
        }).join('');
        const presetItemsHtml = `<div class="import-preset-list">${checkboxesHtml}</div>`;

    dom.modalBody.innerHTML = `
            <div class="import-container">
                <div class="import-section">
                    <h4 class="import-section-title">${t('vocabulary.presetSection')}</h4>
                    <div id="modal-import-list">
                        ${presetItemsHtml}
                    </div>
                </div>
                <div class="import-section">
                    <h4 class="import-section-title">${t('vocabulary.urlSection')}</h4>
                    <div class="input-group">
                         <label for="modal-import-url">${t('vocabulary.urlLabel')}</label>
                         <input type="url" id="modal-import-url" placeholder="https://example.com/words.json">
                    </div>
                </div>
                <div class="import-section">
                    <h4 class="import-section-title">${t('vocabulary.fileSection')}</h4>
                    <div class="input-group">
                        <label for="modal-import-file">${t('vocabulary.fileLabel')}</label>
                        <input type="file" id="modal-import-file" accept=".json">
                    </div>
                </div>
                <div class="import-section" style="border-top:1px dashed var(--line);margin-top:8px;padding-top:8px;">
                    <small class="form-hint">${t('vocabulary.loginSyncHint')}</small>
                </div>
            </div>
            <div id="modal-import-progress" class="import-progress"></div>
            <div class="modal-actions">
                <button class="cancel-btn">${t('common.cancel')}</button>
                <button id="login-to-sync-btn" class="btn-ghost">${t('vocabulary.login')}</button>
                <button class="save-btn">${t('vocabulary.importSelected')}</button>
            </div>
        `;
        dom.appModal.querySelector('.save-btn').onclick = () => importSharedVocabBooks();
        dom.appModal.querySelector('.cancel-btn').onclick = ui.closeModal;
        const loginBtn = dom.appModal.querySelector('#login-to-sync-btn');
        if (loginBtn) loginBtn.onclick = () => { ui.closeModal(); openSyncLoginModal(); };

    } catch (error) {
        console.error('加載預設單詞本失敗:', error);
        dom.modalBody.innerHTML = `<p style="color: red;">${t('vocabulary.loadFailed')}</p>`;
    }
}

async function fetchDefaultWordlists() {
    try {
        const response = await fetch('wordlists/manifest.json');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return await response.json();
    } catch (error) {
        console.error("獲取預設單詞本列表時出錯:", error);
        return [];
    }
}

async function importVocabularySources(sources, options = {}) {
    const {
        onStatus = () => {},
        confirmOverwrite = defaultConfirmOverwrite
    } = options;

    let successCount = 0;
    const summary = [];

    for (const source of sources) {
        try {
            onStatus(t('vocabulary.processingSource', { name: source.name }), { type: 'info' });

            let bookData;
            if (source.type === 'preset' || source.type === 'url') {
                const response = await fetch(source.value);
                if (!response.ok) {
                    throw new Error(t('vocabulary.loadingSourceFailed', { name: source.name }));
                }
                bookData = await response.json();
            } else if (source.type === 'file') {
                bookData = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => {
                        try {
                            resolve(JSON.parse(reader.result));
                        } catch (err) {
                            reject(new Error(t('vocabulary.invalidFile')));
                        }
                    };
                    reader.onerror = () => reject(new Error(t('vocabulary.readFileFailed')));
                    reader.readAsText(source.value);
                });
            } else {
                throw new Error(t('vocabulary.unknownSource'));
            }

            if (!bookData.name || !Array.isArray(bookData.words)) {
                throw new Error(t('vocabulary.invalidSourceData', { name: source.name }));
            }

            const existingBookIndex = state.vocabularyBooks.findIndex(b => b.name === bookData.name);
            if (existingBookIndex > -1) {
                const shouldOverwrite = await Promise.resolve(confirmOverwrite(bookData.name, source));
                if (!shouldOverwrite) {
                    summary.push(t('vocabulary.skipped', { name: bookData.name }));
                    onStatus(t('vocabulary.skipped', { name: bookData.name }), { type: 'info' });
                    continue;
                }
            }

            const wordsWithDetails = [];
            for (let i = 0; i < bookData.words.length; i++) {
                const line = bookData.words[i];
                onStatus(t('vocabulary.parsing', { line, current: i + 1, total: bookData.words.length }), { type: 'info' });

                const parsedWord = parseWordsFromText(line)[0];
                if (!parsedWord) continue;

                if (!parsedWord.meaning || !parsedWord.phonetic) {
                    try {
                        // 使用通用補全：同時照顧單詞與片語（片語可逐詞拼合 IPA）
                        await (await import('../../modules/vocab.js')).ensureWordDetails(parsedWord, { allowDeferForPhrase: false });
                    } catch (_) {
                        const analysis = await api.getWordAnalysis(parsedWord.word);
                        parsedWord.phonetic = parsedWord.phonetic || (analysis.phonetic || 'n/a').replace(/^\/|\/$/g, '');
                        parsedWord.meaning = parsedWord.meaning || analysis.meaning || '';
                    }
                }
                wordsWithDetails.push(parsedWord);
            }

            const newBook = {
                id: Date.now().toString(),
                name: bookData.name,
                words: wordsWithDetails,
                sourceType: 'custom',
                createdAt: new Date().toISOString()
            };

            if (existingBookIndex > -1) {
                state.vocabularyBooks[existingBookIndex] = { ...state.vocabularyBooks[existingBookIndex], ...newBook };
                summary.push(t('vocabulary.overwritten', { name: bookData.name }));
                onStatus(t('vocabulary.overwritten', { name: bookData.name }), { type: 'success' });
            } else {
                state.vocabularyBooks.push(newBook);
                summary.push(t('vocabulary.imported', { name: bookData.name }));
                onStatus(t('vocabulary.imported', { name: bookData.name }), { type: 'success' });
            }

            state.setActiveBookId(newBook.id);
            successCount++;
        } catch (error) {
            console.error(`導入 ${source.name} 失敗:`, error);
            summary.push(`${t('vocabulary.importFailed', { name: source.name })} (${error.message})`);
            onStatus(t('vocabulary.importFailed', { name: source.name }), { type: 'error' });
        }
    }

    if (successCount > 0) {
        const saved = await storage.saveVocabularyBooks();
        if (!saved.ok) {
            onStatus(t('vocabulary.permanentSaveFailed', { message: saved.error || '' }), { type: 'error' });
            return { successCount: 0, summary, error: saved.error };
        }
        renderVocabBookList();
        updateActiveBookView();
    }

    return { successCount, summary };
}

function defaultConfirmOverwrite(bookName) {
    return askConfirm({
        title: t('vocabulary.importSet'),
        message: t('vocabulary.overwriteConfirm', { name: bookName })
    });
}

async function importSharedVocabBooks() {
    const selectedCheckboxes = document.querySelectorAll('.import-checkbox:checked');
    const urlInput = document.getElementById('modal-import-url');
    const fileInput = document.getElementById('modal-import-file');
    const progressContainer = document.getElementById('modal-import-progress');

    const urlPath = urlInput.value.trim();
    const file = fileInput.files[0];

    const sources = Array.from(selectedCheckboxes).map(cb => ({ type: 'preset', value: cb.value, name: cb.dataset.name }));

    if (urlPath) {
        try {
            const url = new URL(urlPath, window.location.href);
            sources.push({ type: 'url', value: url.toString(), name: url.pathname.split('/').pop() || t('vocabulary.urlBook') });
        } catch (_) {
            notify(t('vocabulary.invalidUrl', { url: urlPath }), 'warning');
            return;
        }
    }

    if (file) {
        sources.push({ type: 'file', value: file, name: file.name });
    }

    if (sources.length === 0) {
        notify(t('vocabulary.selectSource'), 'warning');
        return;
    }

    const saveBtn = dom.appModal.querySelector('.save-btn');
    const updateStatus = (message, meta = {}) => {
        if (!progressContainer) return;
        const color = meta.type === 'error' ? 'red' : meta.type === 'success' ? 'green' : 'inherit';
        const colorStyle = color === 'inherit' ? '' : ` style="color: ${color};"`;
        progressContainer.innerHTML = `<p${colorStyle}>${message}</p>`;
    };

    try {
        saveBtn.disabled = true;
        saveBtn.textContent = t('vocabulary.importing');
        if (progressContainer) {
            progressContainer.innerHTML = '';
        }

        const { summary } = await importVocabularySources(sources, {
            onStatus: updateStatus
        });

        const finalMessage = summary.length > 0
            ? t('vocabulary.importComplete', { summary: summary.join('\n') })
            : t('vocabulary.importNoChanges');

        notify(finalMessage, 'success', 6000);
        ui.closeModal();
    } catch (error) {
        console.error('批量導入單詞本失敗:', error);
        notify(t('vocabulary.importProcessFailed'), 'error');
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = t('vocabulary.importSelected');
    }
}

async function saveBookWithAICompletion(bookId = null) {
    const bookNameInput = document.getElementById('modal-book-name');
    const name = bookNameInput.value.trim();
    if (!name) {
        notify(t('vocabulary.nameRequired'), 'warning');
        return;
    }

    // 同名詞書在下拉選單裡長得一模一樣，只能靠 id 分辨，切換時很容易誤操作。
    // 匯入路徑本來就會問「要覆寫嗎」，這裡補上建立／改名時的擋查。
    const duplicated = state.vocabularyBooks.some(b => b.id !== bookId && String(b.name || '').trim() === name);
    if (duplicated) {
        notify(t('vocabulary.duplicateName', { name }), 'warning', 4200);
        try { bookNameInput.focus(); bookNameInput.select(); } catch (_) {}
        return;
    }

    const saveBtn = dom.appModal.querySelector('.save-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = t('vocabulary.processing');

    let book;
    const isEditing = !!bookId;
    if (bookId) {
        book = state.vocabularyBooks.find(b => b.id === bookId);
        if (book) book.name = name;
    } else {
        book = {
            id: Date.now().toString(),
            name: name,
            words: [],
            sourceType: 'custom',
            createdAt: new Date().toISOString()
        };
    }

    const wordsText = document.getElementById('modal-vocab-content').value.trim();
    await processWordsWithAI(book, wordsText);

    // 若為文章專屬單詞本，且編輯彈窗中提供了來源網址欄位，則同步更新 ArticleMeta
    if (isEditing && book && book.sourceType === 'article' && book.articleId && document.getElementById('modal-book-source-url')) {
        try {
            const inputEl = document.getElementById('modal-book-source-url');
            const rawUrl = (inputEl && inputEl.value ? inputEl.value.trim() : '');
            let meta = null;
            if (typeof storage.getArticleMetaById === 'function') {
                try { meta = storage.getArticleMetaById(book.articleId); } catch (_) { meta = null; }
            }
            if (!meta) {
                meta = { id: book.articleId };
            }
            meta.title = book.name;
            if (rawUrl) {
                meta.sourceType = 'url';
                meta.sourceUrl = rawUrl;
            } else {
                // 移除網址，回退來源類型為貼上文字（除非原本已是 file/ocr 等）
                if (meta.sourceUrl) delete meta.sourceUrl;
                if (!meta.sourceType || meta.sourceType === 'url') {
                    meta.sourceType = 'paste';
                }
            }
            storage.saveArticleMeta(meta);
        } catch (_) { /* ignore meta update error */ }
    }

    if (!bookId) {
        state.vocabularyBooks.push(book);
        state.setActiveBookId(book.id);
    }

    const saved = await storage.saveVocabularyBooks();
    if (!saved.ok) {
        ui.displayMessage(t('vocabulary.permanentSaveFailed', { message: saved.error || '' }), 'error', 7000);
        return;
    }
    renderVocabBookList();
    updateActiveBookView();
    ui.closeModal();
}

async function processWordsWithAI(book, wordsText) {
    const progressContainer = document.getElementById('modal-ai-progress');
    const preliminaryWords = parseWordsFromText(wordsText);
    const finalWords = [];

    for (let i = 0; i < preliminaryWords.length; i++) {
        let wordObject = preliminaryWords[i];

        if (!wordObject.meaning.trim() || !wordObject.phonetic.trim()) {
            if(progressContainer) progressContainer.innerHTML = `<p>${tHtml('vocabulary.analyzingProgress', { word: wordObject.word, done: i + 1, total: preliminaryWords.length })}</p>`;
            try {
                const mod = await import('../../modules/vocab.js');
                await mod.ensureWordDetails(wordObject, { allowDeferForPhrase: false });
            } catch (e) {
                console.error(`Error completing word \"${wordObject.word}\":`, e);
                try {
                    const analysis = await api.getWordAnalysis(wordObject.word);
                    wordObject.phonetic = wordObject.phonetic || (analysis.phonetic || 'n/a').replace(/^\/|\/$/g, '');
                    wordObject.meaning = wordObject.meaning || analysis.meaning || t('vocabulary.analysisFailedShort');
                } catch (_) {
                    wordObject.meaning = wordObject.meaning || t('vocabulary.analysisFailedShort');
                    wordObject.phonetic = wordObject.phonetic || 'n/a';
                }
            }
        }
        finalWords.push(wordObject);
    }

    book.words = finalWords;
    if(progressContainer) progressContainer.innerHTML = `<p style="color: green;">${t('vocabulary.processDone')}</p>`;
}

async function deleteActiveVocabBook() {
    const book = state.vocabularyBooks.find(b => b.id === state.activeBookId);
    if (!book) {
        notify(t('vocabulary.selectBook'), 'warning');
        return;
    }

    const confirmed = await askConfirm({
        title: t('vocabulary.deleteBook'),
        message: t('vocabulary.deleteConfirm', { name: book.name }),
        confirmLabel: t('vocabulary.deleteShort'),
        danger: true
    });
    if (!confirmed) return;

    const removedId = book.id;
    const nextBooks = state.vocabularyBooks.filter(b => b.id !== removedId);
    state.setVocabularyBooks(nextBooks);
    state.setActiveBookId(nextBooks.length > 0 ? nextBooks[0].id : null);
    if (state.currentWordbookId === removedId) {
        state.setCurrentWordbookId(null);
    }
    const saved = await storage.saveVocabularyBooks();
    if (!saved.ok) {
        ui.displayMessage(t('vocabulary.permanentSaveFailed', { message: saved.error || '' }), 'error', 6000);
        return;
    }
    storage.saveAppState();
    renderVocabBookList();
    updateActiveBookView();
}

function parseWordsFromText(text) {
    const lines = text.split('\n');
    return lines.map((line, index) => {
        if (!line.trim()) return null;
        let word = '', meaning = '', phonetic = '';
        const atIndex = line.indexOf('@');
        const hashIndex = line.indexOf('#');

        if (atIndex !== -1 && hashIndex !== -1) {
            if (hashIndex < atIndex) {
                word = line.substring(0, hashIndex).trim();
                meaning = line.substring(hashIndex + 1, atIndex).trim();
                phonetic = line.substring(atIndex + 1).trim();
            } else {
                word = line.substring(0, atIndex).trim();
                phonetic = line.substring(atIndex + 1, hashIndex).trim();
                meaning = line.substring(hashIndex + 1).trim();
            }
        } else if (hashIndex !== -1) {
            word = line.substring(0, hashIndex).trim();
            meaning = line.substring(hashIndex + 1).trim();
        } else if (atIndex !== -1) {
            word = line.substring(0, atIndex).trim();
            phonetic = line.substring(atIndex + 1).trim();
        } else {
            word = line.trim();
        }

        if (!word) return null;

        return {
            id: `${Date.now()}-${index}-${Math.random()}`,
            word,
            meaning,
            phonetic: phonetic.replace(/^\/|\/$/g, ''),
            examples: [],
        };
    }).filter(w => w !== null);
}

function exportActiveVocabBook() {
    const activeBook = state.vocabularyBooks.find(b => b.id === state.activeBookId);
    if (!activeBook) {
        notify(t('vocabulary.exportNoActive'), 'warning');
        return;
    }

    const bookData = {
        name: activeBook.name,
        words: activeBook.words.map(w => {
            if (w.meaning && w.phonetic) {
                return `${w.word}#${w.meaning}@${w.phonetic}`;
            } else if (w.meaning) {
                return `${w.word}#${w.meaning}`;
            } else if (w.phonetic) {
                return `${w.word}@${w.phonetic}`;
            }
            return w.word;
        })
    };

    const content = JSON.stringify(bookData, null, 2);
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeBook.name.replace(/[\\/:\*\?"<>\|]/g, '_')}.json`;
    document.body.appendChild(a);
    a.click();

    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    notify(t('vocabulary.exported', { name: activeBook.name }), 'success');
}

function openModalForMergeBooks() {
    if (state.vocabularyBooks.length < 2) {
        notify(t('vocabulary.mergeNeedTwo'), 'warning');
        return;
    }

    dom.modalTitle.textContent = t('vocabulary.mergeTitle');
    dom.modalBody.innerHTML = `
        <div class="merge-layout">
            <div class="merge-selection-panel">
                <h4>${t('vocabulary.mergeSelectBooks')}</h4>
                <div id="merge-book-list" class="import-preset-list">
                    ${state.vocabularyBooks.map(book => `
                        <div class="import-preset-item-wrapper" data-book-id="${escapeAttr(book.id)}">
                            <div class="import-preset-item">${escapeHtml(book.name)} ${t('vocabulary.wordCountSuffix', { count: book.words.length })}</div>
                        </div>
                    `).join('')}
                </div>
            </div>
            <div class="merge-preview-panel">
                <h4>${t('vocabulary.mergePreviewTitle')}</h4>
                <div class="input-group">
                    <label for="modal-merge-book-name">${t('vocabulary.newMergedName')}</label>
                    <input type="text" id="modal-merge-book-name" placeholder="${t('vocabulary.mergedNamePlaceholder')}">
                </div>
                <div id="merge-preview-details">
                    <p><strong>${t('vocabulary.mergeSelectedBooks')}</strong> <span id="merge-selected-count">0</span></p>
                    <ul id="merge-selected-list"></ul>
                    <p><strong>${t('vocabulary.mergeTotalWords')}</strong> <span id="merge-total-words">0</span></p>
                </div>
                <small class="form-hint">${t('vocabulary.dedupeHint')}</small>
                <div class="input-group" style="margin-top:10px;">
                    <label class="checkbox-inline">
                        <input type="checkbox" id="merge-remove-sources">
                        <span>${t('vocabulary.mergeRemoveSources')}</span>
                    </label>
                    <small class="form-hint">${t('vocabulary.keepSourcesHint')}</small>
                </div>
            </div>
        </div>
        <div class="modal-actions">
            <button class="cancel-btn">${t('common.cancel')}</button>
            <button id="confirm-merge-btn" class="save-btn" disabled>${t('vocabulary.merge')}</button>
        </div>
    `;

    const mergeBookList = dom.modalBody.querySelector('#merge-book-list');
    const newBookNameInput = dom.modalBody.querySelector('#modal-merge-book-name');

    mergeBookList.addEventListener('click', (e) => {
        const item = e.target.closest('.import-preset-item-wrapper');
        if (item) {
            item.classList.toggle('selected');
            updateMergePreview();
        }
    });

    newBookNameInput.addEventListener('input', () => updateMergePreview());

    dom.modalBody.querySelector('#confirm-merge-btn').onclick = () => mergeSelectedBooks();
    dom.modalBody.querySelector('.cancel-btn').onclick = ui.closeModal;

    ui.openModal();
    updateMergePreview();
}

function updateMergePreview() {
    const selectedItems = document.querySelectorAll('.import-preset-item-wrapper.selected');
    const newBookName = document.getElementById('modal-merge-book-name').value.trim();
    const selectedCountSpan = document.getElementById('merge-selected-count');
    const selectedListUl = document.getElementById('merge-selected-list');
    const totalWordsSpan = document.getElementById('merge-total-words');
    const confirmBtn = document.getElementById('confirm-merge-btn');

    selectedListUl.innerHTML = '';
    const mergedWords = new Set();
    let selectedBooks = [];

    selectedItems.forEach(item => {
        const bookId = item.dataset.bookId;
        const book = state.vocabularyBooks.find(b => b.id === bookId);
        if (book) {
            selectedBooks.push(book.name);
            book.words.forEach(word => mergedWords.add(word.word.toLowerCase()));
        }
    });

    selectedCountSpan.textContent = selectedItems.length;
    selectedListUl.innerHTML = selectedBooks.map(name => `<li>${escapeHtml(name)}</li>`).join('');
    totalWordsSpan.textContent = mergedWords.size;

    confirmBtn.disabled = !(selectedItems.length >= 2 && newBookName);
}

async function mergeSelectedBooks() {
    const selectedItems = document.querySelectorAll('.import-preset-item-wrapper.selected');
    const newBookName = document.getElementById('modal-merge-book-name').value.trim();
    const removeSources = document.getElementById('merge-remove-sources')?.checked;

    if (selectedItems.length < 2 || !newBookName) {
        return;
    }
    if (state.vocabularyBooks.some(b => b.name === newBookName)) {
        notify(t('vocabulary.duplicateName', { name: newBookName }), 'warning');
        return;
    }

    const mergedWords = [];
    const seenWords = new Set();

    selectedItems.forEach(item => {
        const bookId = item.dataset.bookId;
        const book = state.vocabularyBooks.find(b => b.id === bookId);
        if (book) {
            book.words.forEach(word => {
                const wordIdentifier = word.word.toLowerCase();
                if (!seenWords.has(wordIdentifier)) {
                    mergedWords.push(word);
                    seenWords.add(wordIdentifier);
                }
            });
        }
    });

    const newBook = {
        id: Date.now().toString(),
        name: newBookName,
        words: mergedWords,
        sourceType: 'custom',
        createdAt: new Date().toISOString()
    };

    const selectedIds = Array.from(selectedItems).map(it => it.dataset.bookId);
    let nextBooks = removeSources
        ? state.vocabularyBooks.filter(b => !selectedIds.includes(b.id))
        : [...state.vocabularyBooks];
    nextBooks.push(newBook);

    state.setVocabularyBooks(nextBooks);
    state.setActiveBookId(newBook.id);

    const saved = await storage.saveVocabularyBooks();
    if (!saved.ok) {
        ui.displayMessage(t('vocabulary.permanentSaveFailed', { message: saved.error || '' }), 'error', 6000);
        return;
    }
    storage.saveAppState();
    renderVocabBookList();
    updateActiveBookView();
    ui.closeModal();
    const suffix = removeSources ? t('vocabulary.sourcesDeleted') : '';
    notify(t('vocabulary.mergeSuccess', { count: selectedItems.length, name: newBookName, suffix }), 'success');
}

function renderWordList() {
    stopIncrementalWordRender();
    dom.wordList.innerHTML = '';
    const activeBook = state.vocabularyBooks.find(b => b.id === state.activeBookId);

    if (!activeBook || activeBook.words.length === 0) {
        dom.wordList.innerHTML = `<li class="word-item-placeholder">${t('vocabulary.emptyBook')}</li>`;
        updateWordFilterCount(0, 0);
        return;
    }

    const keyword = (dom.wordFilter?.value || '').trim().toLowerCase();
    const wordsToRender = keyword
        ? activeBook.words.filter(word => {
            const haystack = `${word.word || ''} ${word.meaning || ''} ${word.phonetic || ''}`.toLowerCase();
            return haystack.includes(keyword);
        })
        : activeBook.words;

    updateWordFilterCount(wordsToRender.length, activeBook.words.length);

    if (wordsToRender.length === 0) {
        dom.wordList.innerHTML = `<li class="word-item-placeholder">${tHtml('vocabulary.filterEmpty', { keyword: dom.wordFilter?.value || '' })}</li>`;
        return;
    }

    const phoneticsEnabled = loadGlobalSettings().phonetics?.enabled === true;

    // 一次渲染全部詞條在大型詞書上會產生數萬個 DOM 節點
    // （實測 12000 詞 → 40878 節點、清單高 263994px、渲染 3 秒），
    // 捲動與切換都會卡。改成先渲染一批，捲到底再繼續補。
    startIncrementalWordRender(wordsToRender, phoneticsEnabled);
}

const WORD_RENDER_CHUNK = 150;

/** 目前的增量渲染狀態（換書／換關鍵字時整組重來） */
let wordRenderState = { words: [], rendered: 0, phoneticsEnabled: false, observer: null, sentinel: null };

function startIncrementalWordRender(words, phoneticsEnabled) {
    stopIncrementalWordRender();
    dom.wordList.innerHTML = '';
    wordRenderState = { words, rendered: 0, phoneticsEnabled, observer: null, sentinel: null };

    if (!words.length) return;

    // 哨兵排在清單最後，進入視窗就再補一批（同時顯示「已載入 n / 共 m」）
    // 必須先掛進 DOM：appendWordChunk() 是 insertBefore(fragment, sentinel)
    const sentinel = document.createElement('li');
    sentinel.className = 'word-item-sentinel';
    wordRenderState.sentinel = sentinel;
    dom.wordList.appendChild(sentinel);

    appendWordChunk();

    if (typeof IntersectionObserver === 'function') {
        const observer = new IntersectionObserver((entries) => {
            if (entries.some(e => e.isIntersecting)) appendWordChunk();
        }, { rootMargin: '600px 0px' });
        observer.observe(sentinel);
        wordRenderState.observer = observer;
    } else {
        // 沒有 IntersectionObserver 的環境就退回一次渲染全部，功能不受影響
        while (wordRenderState.rendered < wordRenderState.words.length) appendWordChunk();
    }
}

/** 補上下一批詞條；回傳是否還有剩餘 */
function appendWordChunk() {
    const st = wordRenderState;
    if (!st || st.rendered >= st.words.length) return false;

    const end = Math.min(st.rendered + WORD_RENDER_CHUNK, st.words.length);
    const fragment = document.createDocumentFragment();
    for (let i = st.rendered; i < end; i += 1) {
        fragment.appendChild(buildWordItem(st.words[i], st.phoneticsEnabled));
    }
    st.rendered = end;
    if (st.sentinel) dom.wordList.insertBefore(fragment, st.sentinel);
    else dom.wordList.appendChild(fragment);

    updateWordRenderStatus();
    return st.rendered < st.words.length;
}

function stopIncrementalWordRender() {
    const st = wordRenderState;
    if (st) {
        try { st.observer?.disconnect(); } catch (_) {}
        try { st.sentinel?.remove(); } catch (_) {}
    }
    wordRenderState = { words: [], rendered: 0, phoneticsEnabled: false, observer: null, sentinel: null };
}

/** 未載入完時，把「已載入 n / 共 m」寫在哨兵那一行 */
function updateWordRenderStatus() {
    const st = wordRenderState;
    if (!st?.sentinel) return;
    if (st.rendered >= st.words.length) {
        try { st.observer?.disconnect(); } catch (_) {}
        st.sentinel.remove();
        return;
    }
    st.sentinel.textContent = t('vocabulary.pagingStatus', { shown: st.rendered, total: st.words.length });
}

/** 建立單一詞條 DOM（含事件綁定） */
function buildWordItem(word, phoneticsEnabled) {
    const li = document.createElement('li');
    li.className = 'word-item';
    // 詞條內容來自 AI 文章分析、OCR 辨識與外部匯入的詞表，屬外部可控字串，
    // 一律轉義後才放進 innerHTML（含 data-word-id 屬性值）。
    li.innerHTML = `
        <div class="word-text">
            <strong data-word-id="${escapeAttr(word.id)}">${escapeHtml(word.word)}</strong>
            ${word.phonetic ? `<span class="phonetic">/${escapeHtml(word.phonetic)}/</span>` : ''}
            ${word.meaning ? `<span class="meaning" data-word-id="${escapeAttr(word.id)}">${escapeHtml(word.meaning)}</span>` : ''}
        </div>
        <div class="word-actions">
            <button class="play-btn" title="${escapeAttr(t('vocabulary.playWord'))}" aria-label="${escapeAttr(t('vocabulary.playWord'))}"><svg class="icon icon-sm" aria-hidden="true"><use href="#ic-speaker"/></svg></button>
        </div>
    `;

    if (phoneticsEnabled) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'word-phonetics-btn';
        button.title = t('phonetics.practice');
        button.setAttribute('aria-label', `${t('phonetics.practice')}: ${word.word}`);
        button.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 10v4M8 6v12M12 3v18M16 6v12M20 10v4"/></svg>';
        button.addEventListener('click', event => {
            event.stopPropagation();
            openPhonetics(word);
        });
        li.querySelector('.word-actions').appendChild(button);
    }

    const playBtn = li.querySelector('.play-btn');
    playBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        playWordAndMeaning(word);
    });

    return li;
}

/** 更新篩選結果提示 */
function updateWordFilterCount(shown, total) {
    if (!dom.wordFilterCount) return;
    const keyword = (dom.wordFilter?.value || '').trim();
    if (!keyword) {
        dom.wordFilterCount.textContent = total ? t('vocabulary.totalCount', { count: total }) : '';
        return;
    }
    dom.wordFilterCount.textContent = t('vocabulary.filterCount', { shown, total });
}

function playWordAndMeaning(word) {
    audio.stopCurrentAudio();

    const wordElement = dom.wordList.querySelector(`strong[data-word-id="${word.id}"]`);
    const meaningElement = dom.wordList.querySelector(`span.meaning[data-word-id="${word.id}"]`);

    dom.wordList.querySelectorAll('.highlight').forEach(el => el.classList.remove('highlight'));

    // 使用全局英語朗讀首選（'english' 會由 audio 模組決定 en-GB/en-US）
    audio.speakText(word.word, 'english', 0,
        () => {
            if (wordElement) wordElement.classList.add('highlight');
        },
        () => {
            if (wordElement) wordElement.classList.remove('highlight');

            if (word.meaning) {
                setTimeout(() => {
                    // 使用全局中文朗讀首選（'chinese' 會由 audio 模組決定 zh-CN/zh-HK）
                    audio.speakText(word.meaning, 'chinese', 0,
                        () => {
                            if (meaningElement) meaningElement.classList.add('highlight');
                        },
                        () => {
                            if (meaningElement) meaningElement.classList.remove('highlight');
                        }
                    );
                }, 500);
            }
        }
    );
}
