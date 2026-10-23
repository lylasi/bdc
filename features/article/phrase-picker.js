// 手機「點起詞、點末詞」選短語面板。
//
// 入口：
//   * 單詞浮框「選短語」
//   * 句子詳解 footer
//   * 原生選字工具列（把已選文字帶入預覽）
//
// 面板只使用已捕捉的句子與範圍；儲存不等待 AI，成功後可撤銷。
// 所有使用者可見文字都走 t()，zh-CN / zh-HK 共用同一套邏輯。

import * as dom from '../../modules/dom.js';
import * as ui from '../../modules/ui.js';
import * as readingStore from '../../modules/reading-store.js';
import * as readingActions from '../../modules/reading-actions.js';
import { t } from '../../modules/i18n.js';

const TOKEN_RE = /[A-Za-z][A-Za-z'’-]*/g;

let sheet = null;
let state = null;
let lastFocus = null;
// locale 切換的還原流程是 async（先 flush 再重建）：遞增 token 擋掉舊的還原。
let localeToken = 0;
// Escape 關閉只需要一個 document listener；sheet 重建不得重複绑。
let escapeHandlerBound = false;

function tokensOf(sentence) {
    const text = String(sentence || '');
    const tokens = [];
    TOKEN_RE.lastIndex = 0;
    let match;
    while ((match = TOKEN_RE.exec(text))) {
        tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
    }
    return tokens;
}

function ensureSheet() {
    if (sheet && sheet.isConnected) return sheet;
    sheet = document.createElement('div');
    sheet.id = 'phrase-picker';
    sheet.className = 'phrase-picker hidden';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-labelledby', 'phrase-picker-title');
    sheet.innerHTML = `
      <div class="phrase-picker-backdrop" data-close="1"></div>
      <div class="phrase-picker-sheet" role="document">
        <div class="phrase-picker-head">
          <h3 id="phrase-picker-title">${t('article.phrasePickerTitle')}</h3>
          <button type="button" class="phrase-picker-close" aria-label="${t('article.close')}">×</button>
        </div>
        <p class="phrase-picker-hint" id="phrase-picker-hint">${t('article.phrasePickerHint')}</p>
        <div class="phrase-picker-sentence" id="phrase-picker-sentence"></div>
        <div class="phrase-picker-preview" id="phrase-picker-preview" aria-live="polite"></div>
        <div class="phrase-picker-actions">
          <button type="button" class="btn primary" id="phrase-picker-add">${t('article.addToWordbook')}</button>
          <button type="button" class="btn secondary" id="phrase-picker-mark" aria-pressed="false">${t('article.markThis')}</button>
          <button type="button" class="btn tertiary" id="phrase-picker-note">${t('article.writeNote')}</button>
          <button type="button" class="btn tertiary" id="phrase-picker-ask">${t('article.askAi')}</button>
          <button type="button" class="btn tertiary" id="phrase-picker-reset">${t('article.phraseReset')}</button>
        </div>
        <div class="phrase-picker-note-wrap hidden" id="phrase-picker-note-wrap">
          <label for="phrase-picker-note-input">${t('article.readingNote')}</label>
          <textarea id="phrase-picker-note-input" rows="3" maxlength="20000"></textarea>
          <div class="phrase-picker-note-status" id="phrase-picker-note-status" role="status"></div>
        </div>
        <div class="phrase-picker-foot">
          <span id="phrase-picker-status" role="status" aria-live="polite"></span>
          <button type="button" class="btn tertiary hidden" id="phrase-picker-undo">${t('article.undo')}</button>
        </div>
      </div>`;
    document.body.appendChild(sheet);
    sheet.querySelector('.phrase-picker-close').addEventListener('click', closePhrasePicker);
    sheet.querySelector('[data-close="1"]').addEventListener('click', closePhrasePicker);
    if (!escapeHandlerBound) {
        escapeHandlerBound = true;
        document.addEventListener('keydown', (event) => {
            if (!state || !sheet || sheet.classList.contains('hidden')) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                closePhrasePicker();
            }
        });
    }
    wireActions();
    return sheet;
}

function selectedQuote() {
    if (!state || state.startIndex == null || state.endIndex == null) return '';
    const first = Math.min(state.startIndex, state.endIndex);
    const last = Math.max(state.startIndex, state.endIndex);
    return state.sentence.slice(state.tokens[first].start, state.tokens[last].end);
}

function updatePreview() {
    const quote = selectedQuote();
    const target = currentTarget();
    if (target) currentItemForTarget(target).then((item) => updateMarkButton(item)).catch(() => {});
    const preview = sheet.querySelector('#phrase-picker-preview');
    const add = sheet.querySelector('#phrase-picker-add');
    const hint = sheet.querySelector('#phrase-picker-hint');
    if (!quote) {
        preview.textContent = t('article.phrasePickBoth');
        add.disabled = true;
        if (hint) {
            hint.textContent = state && state.startIndex != null && state.endIndex == null
                ? t('article.phrasePickerPickEnd')
                : t('article.phrasePickerHint');
        }
        return;
    }
    add.disabled = false;
    preview.innerHTML = `<strong>${escapeHtml(quote)}</strong><span class="phrase-picker-sentence-preview">${escapeHtml(state.sentence)}</span>`;
    // 選取完成後必須換掉「請點結束詞」，避免使用者以為尚未選好。
    if (hint) hint.textContent = t('article.phrasePickerSelected');
}

function markTokens() {
    const container = sheet.querySelector('#phrase-picker-sentence');
    if (!state) return;
    const first = state.startIndex == null ? -1 : Math.min(state.startIndex, state.endIndex ?? state.startIndex);
    const last = state.endIndex == null ? first : Math.max(state.startIndex, state.endIndex);
    container.querySelectorAll('.phrase-token').forEach((button) => {
        const index = Number(button.getAttribute('data-index'));
        button.classList.toggle('is-start', index === first && first >= 0);
        button.classList.toggle('is-end', index === last && last >= 0);
        button.classList.toggle('is-selected', first >= 0 && index >= first && index <= last);
        button.setAttribute('aria-pressed', first >= 0 && index >= first && index <= last ? 'true' : 'false');
    });
}

function renderSentence() {
    const container = sheet.querySelector('#phrase-picker-sentence');
    container.innerHTML = '';
    state.tokens.forEach((token, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'phrase-token';
        button.setAttribute('data-index', String(index));
        button.textContent = token.text;
        button.addEventListener('click', () => {
            if (state.startIndex == null || state.endIndex != null) {
                state.startIndex = index;
                state.endIndex = null;
            } else if (state.startIndex === index) {
                state.startIndex = null;
                state.endIndex = null;
            } else {
                state.endIndex = index;
            }
            markTokens();
            updatePreview();
        });
        container.appendChild(button);
    });
    markTokens();
    updatePreview();
}

function status(text, kind = '') {
    const el = sheet.querySelector('#phrase-picker-status');
    el.textContent = text || '';
    el.className = `phrase-picker-status ${kind}`.trim();
}

function setBusy(value) {
    sheet.querySelectorAll('button').forEach((button) => {
        if (button.classList.contains('phrase-picker-close')) return;
        button.disabled = value || (button.id === 'phrase-picker-add' && !selectedQuote());
    });
}

function currentTarget() {
    if (!state) return null;
    const quote = selectedQuote();
    if (!quote) return null;
    const first = Math.min(state.startIndex, state.endIndex);
    const hint = Number(state.sentenceStart) >= 0
        ? Number(state.sentenceStart) + state.tokens[first].start
        : -1;
    // 用面板打開時凍結的內文算錨點，避免期間改寫本文把位置算到新版本。
    const anchor = readingActions.resolveAnchor(state.articleId, quote, state.sentence, hint, state.articleBody);
    return {
        articleId: state.articleId,
        kind: /\s/.test(quote) ? 'phrase' : 'word',
        quote,
        sentence: state.sentence,
        context: state.context,
        anchor,
        contentVersion: state.contentVersion
    };
}

async function ensureTargetItem(target) {
    if (!target) return null;
    const version = state?.contentVersion ?? readingActions.articleVersion(target.articleId);
    const existing = readingStore.findLearningItem(target.articleId, target.kind, target.anchor, version);
    if (existing) return existing;
    const created = await readingActions.ensureItem({
        ...target,
        contentVersion: version,
        actionContext: state?.actionContext || null
    });
    return created.ok ? created.entity : null;
}

function updateMarkButton(item = null) {
    const button = sheet?.querySelector('#phrase-picker-mark');
    if (!button) return;
    const marked = item?.marked === true;
    button.textContent = marked ? t('article.unmarkThis') : t('article.markThis');
    button.setAttribute('aria-pressed', marked ? 'true' : 'false');
    button.classList.toggle('is-active', marked);
}

async function currentItemForTarget(target) {
    if (!target) return null;
    return readingStore.findLearningItem(
        target.articleId,
        target.kind,
        target.anchor,
        state?.contentVersion ?? readingActions.articleVersion(target.articleId)
    );
}

function wireActions() {
    sheet.querySelector('#phrase-picker-reset').addEventListener('click', () => {
        state.startIndex = null;
        state.endIndex = null;
        status('');
        markTokens();
        updatePreview();
    });
    sheet.querySelector('#phrase-picker-add').addEventListener('click', async () => {
        const target = currentTarget();
        if (!target) return;
        if (!readingActions.actionContextActive(state?.actionContext)) {
            status(t('article.saveFailedRetry'), 'error');
            return;
        }
        setBusy(true);
        status(t('article.phraseSaving'), 'pending');
        try {
            const item = await ensureTargetItem(target);
            if (!item) throw new Error('item_failed');
            const result = await readingActions.addItemToVocabulary(item, { context: target.context });
            if (!result || result.ok === false) throw new Error(result?.error || 'save_failed');
            const undo = sheet.querySelector('#phrase-picker-undo');
            if (result.linkId) {
                undo.classList.remove('hidden');
                undo.onclick = async () => {
                    undo.disabled = true;
                    const removed = await readingStore.removeVocabularyLink(result.linkId);
                    undo.classList.add('hidden');
                    status(removed.ok ? t('article.phraseUndone') : t('article.saveFailedRetry'), removed.ok ? '' : 'error');
                    undo.disabled = false;
                };
            }
            status(result.reason === 'duplicate' ? t('article.phraseAlreadySaved') : t('article.phraseSaved'), 'saved');
            updateMarkButton(readingStore.getLearningItem(item.id) || { ...item, marked: true });
            document.dispatchEvent(new CustomEvent('bdc:reading-change', { detail: { articleId: target.articleId } }));
        } catch (error) {
            status(t('article.saveFailedRetry'), 'error');
        } finally {
            setBusy(false);
        }
    });
    sheet.querySelector('#phrase-picker-mark').addEventListener('click', async () => {
        const target = currentTarget();
        if (!target) return;
        if (!readingActions.actionContextActive(state?.actionContext)) {
            status(t('article.saveFailedRetry'), 'error');
            return;
        }
        setBusy(true);
        try {
            const item = await ensureTargetItem(target);
            if (!item) throw new Error('item_failed');
            const latest = readingStore.getLearningItem(item.id) || item;
            const result = await readingActions.setMarked(latest.id, latest.marked !== true, state?.actionContext || null);
            if (!result.ok) throw new Error(result.error);
            updateMarkButton(result.entity || { ...latest, marked: latest.marked !== true });
            status(result.entity?.marked === true ? t('article.markAdded') : t('article.markRemoved'), 'saved');
            document.dispatchEvent(new CustomEvent('bdc:reading-change', { detail: { articleId: target.articleId } }));
        } catch (_) {
            status(t('article.saveFailedRetry'), 'error');
        } finally {
            setBusy(false);
        }
    });
    sheet.querySelector('#phrase-picker-note').addEventListener('click', async () => {
        const target = currentTarget();
        if (!target) return;
        const wrap = sheet.querySelector('#phrase-picker-note-wrap');
        wrap.classList.remove('hidden');
        const input = sheet.querySelector('#phrase-picker-note-input');
        try {
            const item = await ensureTargetItem(target);
            input.value = item?.note || '';
            updateMarkButton(item);
            input.focus();
            let timer = null;
            let saveChain = Promise.resolve({ ok: true });
            const runSave = async () => {
                const noteStatus = sheet.querySelector('#phrase-picker-note-status');
                noteStatus.textContent = t('article.readingSaving');
                const latest = readingStore.findLearningItem(target.articleId, target.kind, target.anchor, state?.contentVersion ?? readingActions.articleVersion(target.articleId));
                if (!latest) {
                    noteStatus.textContent = t('article.saveFailedRetry');
                    return { ok: false, error: 'item_missing' };
                }
                const result = await readingActions.saveNote(latest.id, input.value, state?.actionContext || null);
                noteStatus.textContent = result.ok ? t('article.readingSaved') : t('article.saveFailedRetry');
                if (result.ok) document.dispatchEvent(new CustomEvent('bdc:reading-change', { detail: { articleId: target.articleId } }));
                // 失敗時 input 內容保留，面板不關閉；再按關閉／blur 即重試。
                return result;
            };
            const saveNote = () => {
                clearTimeout(timer);
                saveChain = saveChain.then(runSave, runSave);
                return saveChain;
            };
            input.oninput = () => {
                clearTimeout(timer);
                sheet.querySelector('#phrase-picker-note-status').textContent = t('article.readingSaving');
                timer = setTimeout(() => { saveNote(); }, 450);
            };
            input.onblur = () => { saveNote(); };
            state.flushNote = saveNote;
        } catch (_) {
            status(t('article.saveFailedRetry'), 'error');
        }
    });
    sheet.querySelector('#phrase-picker-ask').addEventListener('click', async () => {
        const target = currentTarget();
        if (!target) return;
        try {
            if (!(window.__assistant && window.__assistant.__ready)) {
                ui.displayMessage(t('assistant.unavailable'), 'warning');
                return;
            }
            const item = await ensureTargetItem(target);
            const reference = t('article.askAiReference', { quote: target.quote });
            const context = {
                learningItemId: item?.id || '',
                anchor: target.anchor,
                contentVersion: target.contentVersion,
                articleId: target.articleId
            };
            const closed = await closePhrasePicker();
            if (!closed.ok) return;
            // 只預填引用，讓使用者自己輸入問題；送出時才帶上來源。
            window.__assistant.compose({ text: reference, context });
        } catch (_) {
            status(t('article.saveFailedRetry'), 'error');
        }
    });
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function openPhrasePicker({
    articleId,
    sentence,
    context = '',
    startWord = '',
    initialQuote = '',
    sentenceStart = -1,
    startOffset = -1
} = {}) {
    if (!articleId || !sentence) return false;
    lastFocus = document.activeElement;
    const element = ensureSheet();
    const tokens = tokensOf(sentence);
    if (!tokens.length) return false;
    let startIndex = null;
    let endIndex = null;
    const findToken = (text) => tokens.findIndex((token) => token.text.toLowerCase() === String(text || '').toLowerCase());
    const tokenAtOffset = (offset) => tokens.findIndex((token) => offset >= token.start && offset < token.end);
    if (Number.isFinite(Number(startOffset)) && Number(startOffset) >= 0) {
        const found = tokenAtOffset(Number(startOffset));
        if (found >= 0) startIndex = found;
    }
    if (startIndex == null && startWord) {
        const found = findToken(startWord);
        if (found >= 0) startIndex = found;
    }
    if (initialQuote) {
        const clean = String(initialQuote).trim();
        const firstToken = (clean.match(TOKEN_RE) || [])[0];
        const lastToken = (clean.match(TOKEN_RE) || []).pop();
        const startHint = Number.isFinite(Number(startOffset)) && Number(startOffset) >= 0
            ? tokenAtOffset(Number(startOffset))
            : -1;
        const first = startHint >= 0 ? startHint : findToken(firstToken);
        let last = findToken(lastToken);
        if (startHint >= 0 && last < first) {
            const count = (clean.match(TOKEN_RE) || []).length;
            last = first + Math.max(0, count - 1);
        }
        if (first >= 0 && last >= 0) {
            startIndex = first;
            endIndex = last;
        }
    }
    state = {
        articleId, sentence, context, tokens, startIndex, endIndex,
        sentenceStart: Number(sentenceStart),
        articleBody: readingActions.articleBody(articleId),
        // 面板打開當下的內文版本與帳戶：所有查狀態、建立條目、筆記一律沿這一份。
        contentVersion: readingActions.articleVersion(articleId),
        actionContext: readingActions.captureActionContext()
    };
    element.classList.remove('hidden');
    element.querySelector('#phrase-picker-hint').textContent = startIndex != null && endIndex != null
        ? t('article.phrasePickerSelected')
        : (startIndex != null ? t('article.phrasePickerPickEnd') : t('article.phrasePickerHint'));
    element.querySelector('#phrase-picker-note-wrap').classList.add('hidden');
    element.querySelector('#phrase-picker-note-input').value = '';
    element.querySelector('#phrase-picker-note-status').textContent = '';
    status('');
    updateMarkButton();
    const undo = element.querySelector('#phrase-picker-undo');
    undo.classList.add('hidden');
    undo.onclick = null;
    renderSentence();
    setTimeout(() => {
        const target = element.querySelector('.phrase-token.is-start') || element.querySelector('.phrase-token');
        if (target) target.focus({ preventScroll: true });
    }, 30);
    return true;
}

/** 匯出／關閉前保存短語面板筆記；失敗回傳 ok:false 且不清除輸入。 */
export async function flushPhrasePickerNote() {
    if (!sheet || !state?.flushNote) return { ok: true, skipped: true };
    try {
        return await state.flushNote();
    } catch (error) {
        return { ok: false, error: error && error.message ? error.message : 'note_save_failed' };
    }
}

export async function closePhrasePicker() {
    if (!sheet) return { ok: true };
    const flushed = await flushPhrasePickerNote();
    if (!flushed || flushed.ok === false) {
        status(t('article.saveFailedRetry'), 'error');
        return { ok: false, error: flushed?.error || 'note_save_failed' };
    }
    sheet.classList.add('hidden');
    state = null;
    if (lastFocus && typeof lastFocus.focus === 'function') {
        try { lastFocus.focus({ preventScroll: true }); } catch (_) { lastFocus.focus(); }
    }
    lastFocus = null;
    return { ok: true };
}

export function initPhrasePicker() {
    ensureSheet();
    document.addEventListener('bdc:locale-change', async () => {
        const token = ++localeToken;
        // 沒有開啟中的短語面板：只重建 DOM，讓上方文案跟著換語言。
        if (!state) {
            if (sheet) { sheet.remove(); sheet = null; }
            ensureSheet();
            return;
        }
        const snapshot = captureSheetState();
        // 先保存正在輸入的筆記；失敗時保留舊 sheet 與草稿，不 remove，讓使用者重試。
        const flushed = await flushPhrasePickerNote();
        if (token !== localeToken) return;
        if (!flushed || flushed.ok === false) {
            status(t('article.saveFailedRetry'), 'error');
            return;
        }
        if (sheet) { sheet.remove(); sheet = null; }
        ensureSheet();
        if (!snapshot.wasOpen) return;
        restoreSheetState(snapshot, token);
    });
}

/** 切語言前記住選取範圍、焦點詞與筆記區塊狀態（草稿内容由 flush 負責落地）。 */
function captureSheetState() {
    const active = document.activeElement;
    const tokenIndex = active && active.classList?.contains('phrase-token')
        ? Number(active.getAttribute('data-index'))
        : null;
    const noteWrap = sheet?.querySelector('#phrase-picker-note-wrap');
    return {
        wasOpen: !!sheet && !sheet.classList.contains('hidden'),
        articleId: state?.articleId || '',
        sentence: state?.sentence || '',
        context: state?.context || '',
        sentenceStart: Number(state?.sentenceStart),
        startIndex: state?.startIndex ?? null,
        endIndex: state?.endIndex ?? null,
        focusedTokenIndex: Number.isInteger(tokenIndex) ? tokenIndex : null,
        noteOpen: !!noteWrap && !noteWrap.classList.contains('hidden'),
        noteFocused: !!active && active.id === 'phrase-picker-note-input'
    };
}

/**
 * 用同一份文章與句子重開面板，再把選取範圍、筆記區塊與焦點放回去。
 * token 索引由同一句推導，重開後仍對得上。
 */
function restoreSheetState(snapshot, token) {
    const reopened = openPhrasePicker({
        articleId: snapshot.articleId,
        sentence: snapshot.sentence,
        context: snapshot.context,
        sentenceStart: snapshot.sentenceStart
    });
    if (!reopened || !state || !sheet) return;
    if (snapshot.startIndex != null) {
        state.startIndex = snapshot.startIndex;
        state.endIndex = snapshot.endIndex;
        markTokens();
        updatePreview();
        const hint = sheet.querySelector('#phrase-picker-hint');
        if (hint) {
            hint.textContent = state.endIndex != null
                ? t('article.phrasePickerSelected')
                : t('article.phrasePickerPickEnd');
        }
    }
    // 已保存成功：重開筆記區塊會讀回同一份内容，不會空白。
    if (snapshot.noteOpen) sheet.querySelector('#phrase-picker-note')?.click();
    // openPhrasePicker 會在 30ms 後把焦點移到起詞；等它跑完再還原真正的焦點。
    setTimeout(() => {
        if (token !== localeToken || !sheet || !state) return;
        if (snapshot.noteOpen && snapshot.noteFocused) {
            sheet.querySelector('#phrase-picker-note-input')?.focus({ preventScroll: true });
            return;
        }
        const focusIndex = snapshot.focusedTokenIndex;
        const target = focusIndex != null
            ? sheet.querySelector(`.phrase-token[data-index="${focusIndex}"]`)
            : (sheet.querySelector('.phrase-token.is-start') || sheet.querySelector('.phrase-token'));
        if (target) {
            try { target.focus({ preventScroll: true }); } catch (_) { /* noop */ }
        }
    }, 60);
}
