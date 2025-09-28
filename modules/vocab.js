import * as state from './state.js';
import * as storage from './storage.js';
import * as ui from './ui.js';
import * as api from './api.js';

// Vocabulary helpers: default book, add/dedupe, and AI completion

const DEFAULT_BOOK_NAME = '生詞本';

// In-memory IPA cache to reduce重複查詢（瀏覽器刷新即清空）
const _ipaCache = new Map(); // key: lowercase word, value: IPA string (no leading/trailing slashes)

function nowId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function _collapseSpaces(s) {
    return s.replace(/\s+/g, ' ').trim();
}

// 規範化用於去重的 key：
// - 移除首尾非字母數字的符號（含中英文標點與括號/引號）
// - 合併多空白，轉小寫，比對更穩定
function normalizeWordKey(text) {
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
function cleanDisplayText(text) {
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
    let book = state.vocabularyBooks.find(b => b && b.name === DEFAULT_BOOK_NAME);
    if (book) return book;
    // not found: create a new one; do not change activeBookId (avoid UI jump)
    const newBook = { id: nowId(), name: DEFAULT_BOOK_NAME, words: [] };
    state.vocabularyBooks.push(newBook);
    storage.saveVocabularyBooks();
    try { storage.saveAppState(); } catch (_) {}
    return newBook;
}

export function getDefaultWordbook() {
    return state.vocabularyBooks.find(b => b && b.name === DEFAULT_BOOK_NAME) || null;
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

export async function addWordToDefaultBook(text, options = {}) {
    const { source = 'article', sentence = '', context = '', meaning: hintMeaning = '', phonetic: hintPhonetic = '', pos: hintPos = '' } = options;
    const raw = (text || '').trim();
    const key = normalizeWordKey(raw);
    if (!key) {
        ui.displayMessage('沒有可加入的文字。', 'warning');
        return { ok: false, reason: 'empty' };
    }

    const book = ensureDefaultWordbook();
    const dup = findInBookByWord(book, key);
    if (dup) {
        ui.displayMessage(`「${cleanDisplayText(raw)}」已存在於《${DEFAULT_BOOK_NAME}》。`, 'info');
        return { ok: true, reason: 'duplicate', id: dup.id };
    }

    const entry = {
        id: nowId(),
        word: cleanDisplayText(raw),
        meaning: cleanDisplayText(hintMeaning) || '',
        phonetic: (hintPhonetic || '').replace(/^\/|\/$/g, ''),
        examples: [],
        addedAt: new Date().toISOString(),
        source,
        context: sentence || context || ''
    };
    if (hintPos && !entry.pos) entry.pos = hintPos;

    // Try to complete details now; phrases may defer meaning if context not available
    try {
        // 若已有語境中提取的意思/音標，就不再額外請求；否則再補齊
        const hasMeaning = entry.meaning && entry.meaning.trim();
        const hasPhon = entry.phonetic && entry.phonetic.trim() && entry.phonetic !== 'n/a';
        if (!hasMeaning || !hasPhon) {
            await ensureWordDetails(entry, { sentence, context, allowDeferForPhrase: true });
        }
    } catch (_) {}

    book.words.push(entry);
    storage.saveVocabularyBooks();
    ui.displayMessage(`已加入「${raw}」到《${DEFAULT_BOOK_NAME}》。`, 'success');
    return { ok: true, id: entry.id };
}
