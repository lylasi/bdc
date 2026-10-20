import * as state from './state.js';
import * as storage from './storage.js';
import * as ui from './ui.js';
import * as api from './api.js';
import * as articleStore from './article-store.js';
import * as readingStore from './reading-store.js';
import { contentVersionOf, normalizeAnchor } from '../shared/reading-protocol.mjs';
import { t } from './i18n.js';

// Vocabulary helpers: default book, add/dedupe, and AI completion

// i18n-allow: 舊版預設書名，用來比對既有資料，翻譯了就認不出來
const LEGACY_DEFAULT_BOOK_NAMES = ['生詞本', '单词本'];

function getDefaultBookName() {
    return t('vocabulary.defaultBookName');
}

function getDisplayBookName(book) {
    const name = book?.name || getDefaultBookName();
    return LEGACY_DEFAULT_BOOK_NAMES.includes(name) ? getDefaultBookName() : name;
}

// In-memory IPA cache to reduce重複查詢（瀏覽器刷新即清空）
const _ipaCache = new Map(); // key: lowercase word, value: IPA string (no leading/trailing slashes)

function nowId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function _collapseSpaces(s) {
    return s.replace(/\s+/g, ' ').trim();
}

// 規範化用於去重的 key：
// - 移除首尾非字母數字的符號（含中英文標點與括號/引號）
// - 合併多空白，轉小寫，比對更穩定
export function normalizeWordKey(text) {
    let s = String(text || '');
    s = _collapseSpaces(s);
    // 去除首尾常見標點與括號、引號（中英文）
    s = s.replace(/^[\s"'“”‘’()\[\]{}<>，。！？；：,.!?;:]+/, '');
    s = s.replace(/[\s"'“”‘’()\[\]{}<>，。！？；：,.!?;:]+$/, '');
    // 再次合併空白
    s = _collapseSpaces(s);
    return s.toLowerCase();
}

// 顯示文字的清理（保留原大小寫，但移除首尾噪音符號與多餘空白）
export function cleanDisplayText(text) {
    let s = String(text || '');
    s = _collapseSpaces(s);
    s = s.replace(/^[\s"'“”‘’()\[\]{}<>，。！？；：,.!?;:]+/, '');
    s = s.replace(/[\s"'“”‘’()\[\]{}<>，。！？；：,.!?;:]+$/, '');
    return _collapseSpaces(s);
}

function isPhrase(text) {
    // treat as phrase if it contains whitespace or multiple tokens
    return /\s/.test((text || '').trim());
}

export function ensureDefaultWordbook() {
    // find existing default book by name
    let book = state.vocabularyBooks.find(b => b && LEGACY_DEFAULT_BOOK_NAMES.includes(b.name));
    if (book) return book;
    // not found: create a new one; do not change activeBookId (avoid UI jump)
    const newBook = { id: nowId(), name: getDefaultBookName(), words: [] };
    state.vocabularyBooks.push(newBook);
    storage.saveVocabularyBooks();
    try { storage.saveAppState(); } catch (_) {}
    return newBook;
}

export function getDefaultWordbook() {
    return state.vocabularyBooks.find(b => b && LEGACY_DEFAULT_BOOK_NAMES.includes(b.name)) || null;
}

export async function ensureWordDetails(entry, opts = {}) {
    const { sentence = '', context = '', allowDeferForPhrase = true } = opts;
    const text = (entry.word || '').trim();
    const phrase = isPhrase(text);

    // Already has details
    const hasPhon = entry.phonetic && entry.phonetic.trim() && entry.phonetic !== 'n/a';
    const hasMeaning = entry.meaning && entry.meaning.trim();
    if (hasPhon && hasMeaning) return entry;

    // 先嘗試『帶上下文的片語/詞解析』，以取得最符合原文語境的中文意思
    // 適用單詞與片語，只要提供了 sentence/context 即啟用
    if ((sentence || context) && !hasMeaning) {
        try {
            const sel = await api.analyzeSelection(text, sentence || '', context || '', { timeoutMs: 12000 });
            if (sel && sel.analysis) {
                // 優先採用語境對應的 meaning
                if (!entry.meaning && sel.analysis.meaning) {
                    entry.meaning = sel.analysis.meaning;
                }
                // 若有給出片語/單詞的 IPA，也一併帶回
                const selPhon = (sel.analysis.phonetic || '').replace(/^\/|\/$/g, '');
                if (!entry.phonetic && selPhon) entry.phonetic = selPhon;
            }
        } catch (_) {
            // 忽略失敗，轉用一般詞典接口
        }
    }

    try {
        if (!phrase) {
            // single word: use dedicated analysis API
            if (!hasMeaning || !hasPhon) {
                const res = await api.getWordAnalysis(text);
                if (res) {
                    if (!entry.phonetic) entry.phonetic = (res.phonetic || 'n/a').replace(/^\/|\/$/g, '');
                    if (!entry.meaning) entry.meaning = res.meaning || '';
                    if (!entry.pos) entry.pos = res.pos || '';
                }
            }
        } else {
            // phrase: 先以 selection 解析補齊釋義與音標；若無上下文或未得結果，再嘗試整體或逐詞拼合 IPA。
            // 此處的 analyzeSelection 已在上方共通處理過；這裡保留原 fallback 流程

            // 若音標仍缺失，嘗試直接對整個片語做分析（部分模型能給出片語 IPA）
            if (!entry.phonetic || entry.phonetic === 'n/a') {
                try {
                    const res = await api.getWordAnalysis(text);
                    const wholePhon = (res?.phonetic || '').replace(/^\/|\/$/g, '');
                    if (wholePhon) entry.phonetic = wholePhon;
                    // 同時可順帶補上中文
                    if (!entry.meaning) entry.meaning = res?.meaning || '';
                } catch(_) {}
            }

            // 若仍無法取得整體 IPA，最後以逐詞 IPA 串接作為降級（e.g., "make bread" -> "meɪk bred"）
            if (!entry.phonetic || entry.phonetic === 'n/a') {
                try {
                    const tokens = (text.match(/[A-Za-z']+/g) || []).map(t => t.toLowerCase());
                    const ipas = [];
                    for (const tok of tokens) {
                        if (!tok) continue;
                        let ipa = _ipaCache.get(tok);
                        if (!ipa) {
                            try {
                                const r = await api.getWordAnalysis(tok);
                                ipa = (r?.phonetic || '').replace(/^\/|\/$/g, '');
                                if (ipa) _ipaCache.set(tok, ipa);
                            } catch(_) { ipa = ''; }
                        }
                        ipas.push(ipa || tok); // 若取不到 IPA，退回原字避免留空位
                    }
                    const joined = ipas.join(' ').trim();
                    if (joined) entry.phonetic = joined;
                } catch(_) {}
            }

            // 釋義補齊（若允許即時補）
            if (!entry.meaning && !allowDeferForPhrase) {
                try {
                    const res = await api.getWordAnalysis(text);
                    entry.meaning = res?.meaning || '';
                    if (!entry.phonetic && res?.phonetic) entry.phonetic = String(res.phonetic).replace(/^\/|\/$/g, '');
                } catch (_) {}
            }

            // 最低保證：仍無音標則標為 n/a（方便下次批次補全識別）
            if (!entry.phonetic) entry.phonetic = 'n/a';
        }
    } catch (err) {
        // minimal placeholders
        if (!entry.phonetic) entry.phonetic = 'n/a';
        if (!entry.meaning) entry.meaning = '';
    }
    return entry;
}

export function findInBookByWord(book, text) {
    const key = normalizeWordKey(text);
    return (book.words || []).find(w => normalizeWordKey(w.word) === key) || null;
}

function nowIso() {
    return new Date().toISOString();
}

function insertEntryIntoMemory(bookId, entry) {
    const books = Array.isArray(state.vocabularyBooks) ? state.vocabularyBooks : [];
    const next = books.map((book) => {
        if (!book || book.id !== bookId) return book;
        const words = Array.isArray(book.words) ? book.words.filter((item) => item && item.id !== entry.id) : [];
        words.push(entry);
        return { ...book, words };
    });
    state.setVocabularyBooks(next);
}

function buildEntrySource(options, text) {
    const articleId = options.articleId || state.currentArticleId || '';
    const record = articleId ? articleStore.getRecord(articleId) : null;
    const body = record?.article || '';
    const anchor = options.anchor ? normalizeAnchor(options.anchor) : normalizeAnchor({ start: -1, end: -1, quote: text });
    return {
        sentence: options.sentence || '',
        context: options.context || '',
        articleId,
        contentVersion: options.contentVersion || (body ? contentVersionOf(body) : (record?.contentVersion || '')),
        anchor,
        addedAt: nowIso()
    };
}

function appendSource(entry, source) {
    const sources = Array.isArray(entry.sources) ? [...entry.sources] : [];
    const exists = sources.some((item) => item
        && item.articleId === source.articleId
        && item.sentence === source.sentence
        && item.anchor?.start === source.anchor?.start
        && item.anchor?.quote === source.anchor?.quote);
    if (!exists && (source.articleId || source.sentence)) sources.push(source);
    return { ...entry, sources };
}

async function ensureArticleItem({ text, kind, source, meaning = '', phonetic = '', itemId = '' }) {
    if (itemId) {
        const existing = readingStore.getLearningItem(itemId);
        if (existing) return existing;
    }
    if (!source.articleId || !source.anchor.quote) return null;
    const existing = readingStore.findLearningItem(source.articleId, kind, source.anchor, source.contentVersion);
    if (existing) return existing;
    return {
        // 與 reading-store 的 occurrence 穩定 ID 一致；兩個分頁同時收藏
        // 同一位置時會在交易內落到同一筆，不會重複建立。
        id: readingStore.stableLearningItemId({
            articleId: source.articleId,
            contentVersion: source.contentVersion,
            kind,
            anchor: source.anchor,
            sentence: source.sentence
        }),
        articleId: source.articleId,
        contentVersion: source.contentVersion,
        kind,
        anchor: source.anchor,
        sentence: source.sentence,
        explanation: meaning ? {
            language: '',
            result: { meaning, phonetic },
            generatedAt: nowIso(),
            provenance: { source: 'vocabulary_hint' }
        } : null,
        firstViewedAt: null,
        lastViewedAt: null,
        marked: false,
        understanding: 'unmarked',
        note: '',
        createdAt: nowIso(),
        updatedAt: nowIso(),
        deletedAt: ''
    };
}

/** 只帶定義欄位進交易；筆記／標記狀態一律以交易內讀到的最新版本為準。 */
function learningItemPayloadForVocabulary(item) {
    if (!item) return null;
    return {
        id: item.id,
        articleId: item.articleId,
        contentVersion: item.contentVersion,
        kind: item.kind,
        anchor: item.anchor,
        sentence: item.sentence,
        explanation: item.explanation ?? null,
        createdAt: item.createdAt
    };
}

export async function addWordToDefaultBook(text, options = {}) {
    const { source = 'article', sentence = '', context = '', meaning: hintMeaning = '', phonetic: hintPhonetic = '', pos: hintPos = '' } = options;
    const raw = (text || '').trim();
    const key = normalizeWordKey(raw);
    if (!key) {
        ui.displayMessage(t('vocabulary.nothingToAdd'), 'warning');
        return { ok: false, reason: 'empty' };
    }

    const book = ensureDefaultWordbook();
    const dup = findInBookByWord(book, key);
    if (dup) {
        ui.displayMessage(t('vocabulary.existsInBook', { word: cleanDisplayText(raw), book: getDisplayBookName(book) }), 'info');
        return { ok: true, reason: 'duplicate', id: dup.id };
    }

    const entry = {
        id: nowId(),
        word: cleanDisplayText(raw),
        meaning: cleanDisplayText(hintMeaning) || '',
        phonetic: (hintPhonetic || '').replace(/^\/|\/$/g, ''),
        examples: [],
        sources: [],
        addedAt: nowIso(),
        source,
        context: sentence || context || ''
    };
    if (hintPos && !entry.pos) entry.pos = hintPos;

    // 先保存詞條，AI 補全放到背景：離線或慢網也能立即收藏。
    const saved = await readingStore.upsertVocabularyEntry({ ...entry, bookId: book.id });
    if (!saved.ok) {
        ui.displayMessage(t('vocabulary.addFailed', { message: saved.error || '' }), 'error');
        return { ok: false, reason: 'save_failed', error: saved.error };
    }
    insertEntryIntoMemory(book.id, { ...entry, bookId: book.id });
    storage.saveVocabularyBooks({ suppressPermanent: true });
    ui.displayMessage(t('vocabulary.addedToBook', { word: raw, book: getDisplayBookName(book) }), 'success');

    ensureWordDetails(entry, { sentence, context, allowDeferForPhrase: true })
        .then(async (enriched) => {
            if (!enriched || (!enriched.meaning && !enriched.phonetic)) return;
            const current = readingStore.getVocabularyEntry(entry.id);
            if (!current) return;
            await readingStore.upsertVocabularyEntry({ ...current, meaning: enriched.meaning || current.meaning, phonetic: enriched.phonetic || current.phonetic, pos: enriched.pos || current.pos });
            insertEntryIntoMemory(book.id, { ...current, meaning: enriched.meaning || current.meaning, phonetic: enriched.phonetic || current.phonetic, pos: enriched.pos || current.pos });
            storage.saveVocabularyBooks({ suppressPermanent: true });
        })
        .catch(() => {});
    return { ok: true, id: entry.id, bookId: book.id };
}

export async function addWordToCurrentArticleBook(text, options = {}) {
    const {
        source = 'article',
        sentence = '',
        context = '',
        meaning: hintMeaning = '',
        phonetic: hintPhonetic = '',
        pos: hintPos = '',
        anchor = null,
        articleId = '',
        contentVersion = '',
        kind = '',
        itemId = ''
    } = options;

    const raw = (text || '').trim();
    const key = normalizeWordKey(raw);
    if (!key) {
        ui.displayMessage(t('vocabulary.nothingToAdd'), 'warning');
        return { ok: false, reason: 'empty' };
    }

    // 優先使用當前綁定的文章生詞本
    let book = null;
    const wbId = state.currentWordbookId;
    if (wbId) {
        try { book = storage.getWordbookById(wbId); } catch (_) { /* ignore */ }
        if (!book) {
            // 文章由獨立文章儲存建立時，storage 可能還沒有對應的詞書 metadata；
            // 直接以同一個穩定 ID 建立，避免落到「未命名文章」或別的預設詞書。
            const record = articleStore.getRecord(wbId) || articleStore.getRecord(articleId);
            try {
                book = storage.saveWordbook({
                    id: wbId,
                    name: record?.title || t('article.untitled'),
                    sourceType: 'article',
                    articleId: wbId,
                    words: []
                });
            } catch (_) { book = null; }
        }
    }
    if (!book) {
        const articleForBook = articleId || state.currentArticleId || null;
        if (articleForBook && typeof storage.getArticleMetaById === 'function' && typeof storage.getOrCreateArticleWordbook === 'function') {
            try {
                const meta = storage.getArticleMetaById(articleForBook) || { id: articleForBook, title: t('errors.untitledArticle'), sourceType: 'paste' };
                const res = storage.getOrCreateArticleWordbook(meta, { createWordbook: true });
                if (res && res.wordbook) book = res.wordbook;
            } catch (_) { /* ignore and fall back */ }
        }
        if (!book) book = ensureDefaultWordbook();
    }

    const entryKind = kind || (/\s/.test(cleanDisplayText(raw)) ? 'phrase' : 'word');
    const effectiveArticleId = articleId || state.currentArticleId || '';
    if (effectiveArticleId && !articleStore.getRecord(effectiveArticleId)) {
        return { ok: false, reason: 'stale_scope', error: 'stale_scope' };
    }
    const sourceInfo = buildEntrySource({ ...options, articleId: effectiveArticleId, contentVersion }, cleanDisplayText(raw));
    const item = await ensureArticleItem({ text: raw, kind: entryKind, source: sourceInfo, meaning: hintMeaning, phonetic: hintPhonetic, itemId });
    const itemPayload = learningItemPayloadForVocabulary(item);

    const dup = findInBookByWord(book, key);
    if (dup) {
        // 同詞已有詞條：不丟新語境，追加來源並建立這篇文章的關聯。
        const nextDup = appendSource({ ...dup, bookId: book.id }, sourceInfo);
        const linkId = item ? `vl_${item.id}_${dup.id}` : '';
        const result = await readingStore.addVocabularyEntryWithLink({
            book: { ...book },
            entry: { ...nextDup, id: dup.id, bookId: book.id },
            item: itemPayload,
            link: linkId ? {
                id: linkId,
                itemId: item.id,
                bookId: book.id,
                entryId: dup.id,
                addedAt: nowIso(),
                removedAt: '',
                positionUnknown: sourceInfo.anchor.start < 0
            } : null
        });
        if (!result.ok) {
            ui.displayMessage(t('vocabulary.addFailed', { message: result.error || '' }), 'error');
            return { ok: false, reason: 'save_failed', error: result.error };
        }
        insertEntryIntoMemory(book.id, result.entry || nextDup);
        storage.saveVocabularyBooks({ suppressPermanent: true });
        ui.displayMessage(t('vocabulary.existsInBook', { word: cleanDisplayText(raw), book: getDisplayBookName(book) }), 'info');
        return {
            ok: true,
            reason: 'duplicate',
            id: dup.id,
            bookId: book.id,
            linked: !!linkId,
            linkId: result.linkId || linkId,
            itemId: result.itemId || item?.id || '',
            marked: true
        };
    }

    const entry = {
        id: nowId(),
        word: cleanDisplayText(raw),
        meaning: cleanDisplayText(hintMeaning) || '',
        phonetic: (hintPhonetic || '').replace(/^\/|\/$/g, ''),
        examples: [],
        sources: [sourceInfo],
        addedAt: nowIso(),
        source,
        context: sentence || context || ''
    };
    if (hintPos && !entry.pos) entry.pos = hintPos;
    if (sourceInfo.articleId) entry.sourceArticleId = sourceInfo.articleId;

    const linkId = item ? `vl_${item.id}_${entry.id}` : '';
    const saved = await readingStore.addVocabularyEntryWithLink({
        book: { ...book },
        entry: { ...entry, bookId: book.id },
        item: itemPayload,
        link: linkId ? {
            id: linkId,
            itemId: item.id,
            bookId: book.id,
            entryId: entry.id,
            addedAt: nowIso(),
            removedAt: '',
            positionUnknown: sourceInfo.anchor.start < 0
        } : null
    });
    if (!saved.ok) {
        ui.displayMessage(t('vocabulary.addFailed', { message: saved.error || '' }), 'error');
        return { ok: false, reason: 'save_failed', error: saved.error };
    }
    insertEntryIntoMemory(book.id, saved.entry || { ...entry, bookId: book.id });
    storage.saveVocabularyBooks({ suppressPermanent: true });
    ui.displayMessage(t('vocabulary.addedToBook', { word: raw, book: getDisplayBookName(book) }), 'success');

    // 先顯示成功，再背景補齊釋義／音標；補全失敗不影響收藏。
    ensureWordDetails(entry, { sentence, context, allowDeferForPhrase: true })
        .then(async (enriched) => {
            if (!enriched || (!enriched.meaning && !enriched.phonetic)) return;
            const current = readingStore.getVocabularyEntry(entry.id);
            if (!current) return;
            const updated = {
                ...current,
                meaning: enriched.meaning || current.meaning,
                phonetic: enriched.phonetic || current.phonetic,
                pos: enriched.pos || current.pos
            };
            await readingStore.upsertVocabularyEntry(updated);
            insertEntryIntoMemory(book.id, updated);
            storage.saveVocabularyBooks({ suppressPermanent: true });
        })
        .catch(() => {});
    return { ok: true, id: entry.id, bookId: book.id, linked: !!linkId, linkId: saved.linkId || linkId, itemId: saved.itemId || item?.id || '', marked: true };
}
