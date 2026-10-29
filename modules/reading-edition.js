// 單一文章的唯讀 HTML 閱讀版；只使用呼叫者固定的本機快照。
import { t, getLocaleTag, formatDateTime } from './i18n.js';
import { markdownToHtml } from './markdown.js';
import { contentVersionOf } from '../shared/reading-protocol.mjs';

const AUDIO_TYPES = new Set([
    'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg',
    'audio/webm', 'audio/flac', 'audio/aac'
]);
const MARKDOWN_TAGS = new Set([
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del',
    'code', 'pre', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th',
    'td', 'ol', 'ul', 'li', 'hr', 'br', 'a'
]);
const CREDENTIAL_KEY = /^(?:api[-_]?key|x[-_]api[-_]key|key|token|(?:access|refresh|id|auth)[-_]?token|auth(?:orization)?|password|passwd|(?:client[-_])?secret|signature|sig|credentials?|session(?:[-_]?id)?|jwt|bearer|code|subscription[-_]?key|x[-_](?:amz|goog)[-_](?:credential|signature|security[-_]token))$/i;

const asArray = (value) => Array.isArray(value) ? value : [];
const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const hasId = (value) => typeof value === 'string' && value.length > 0;
const compareText = (a, b) => a < b ? -1 : (a > b ? 1 : 0);
const byCreated = (a, b) => {
    const left = Date.parse(a.createdAt || '');
    const right = Date.parse(b.createdAt || '');
    const dates = (Number.isFinite(left) ? left : -Infinity)
        - (Number.isFinite(right) ? right : -Infinity);
    return (Number.isNaN(dates) ? compareText(String(a.createdAt || ''), String(b.createdAt || '')) : dates)
        || compareText(String(a.id || ''), String(b.id || ''));
};
const sourcePosition = (item) => Number.isInteger(item.anchor?.start) && item.anchor.start >= 0
    ? item.anchor.start : Infinity;
const byPosition = (a, b) => (sourcePosition(a) - sourcePosition(b)) || byCreated(a, b);

/**
 * 防守式地收窄舊版／fallback 快照。保留原快照的狀態等欄位，不更改輸入。
 * messages 是權威清單；只有缺少清單時才從 messagesByConversation 重建。
 */
export function selectArticleReading(snapshot, articleId) {
    const original = isRecord(snapshot) ? snapshot : {};
    const inScope = (entity) => isRecord(entity) && !entity.deletedAt
        && (!original.scope || !entity.scope || entity.scope === original.scope);
    const doc = original.articleDoc;
    const articleDoc = hasId(articleId) && inScope(doc)
        && (doc.id || doc.articleId) === articleId
        && (!doc.articleId || doc.articleId === articleId)
        ? doc : null;
    const forArticle = (entity) => !!articleDoc && inScope(entity) && entity.articleId === articleId;
    const learningItems = asArray(original.learningItems).filter(forArticle).sort(byPosition);
    const articleDocuments = asArray(original.articleDocuments).filter(forArticle).sort(byCreated);
    const conversations = asArray(original.conversations).filter(forArticle).sort(byCreated);
    const conversationIds = new Set(conversations.map((conv) => conv.id).filter(hasId));
    const grouped = original.messagesByConversation;
    const fallbackMessages = grouped instanceof Map
        ? Array.from(grouped.values()).flatMap(asArray)
        : (isRecord(grouped) ? Object.values(grouped).flatMap(asArray) : []);
    const messages = (Array.isArray(original.messages) ? original.messages : fallbackMessages)
        .filter((message) => inScope(message) && conversationIds.has(message.conversationId)
            && (!message.articleId || message.articleId === articleId))
        .sort(byCreated);
    const messagesByConversation = new Map(conversations.map((conv) => [conv.id, []]));
    for (const message of messages) messagesByConversation.get(message.conversationId).push(message);

    const itemIds = new Set(learningItems.map((item) => item.id).filter(hasId));
    const liveBooks = asArray(original.vocabularyBooks).filter(inScope);
    const liveEntries = asArray(original.vocabularyEntries).filter(inScope);
    const booksById = new Map(liveBooks.map((book) => [book.id, book]));
    const entriesById = new Map(liveEntries.map((entry) => [entry.id, entry]));
    const vocabularyLinks = asArray(original.vocabularyLinks).filter((link) => {
        if (!inScope(link) || link.removedAt || !itemIds.has(link.itemId)) return false;
        const entry = entriesById.get(link.entryId);
        return hasId(link.bookId) && booksById.has(link.bookId)
            && !!entry && entry.bookId === link.bookId;
    });
    const bookIds = new Set(vocabularyLinks.map((link) => link.bookId));
    const entryIds = new Set(vocabularyLinks.map((link) => link.entryId));
    return {
        ...original,
        articleId,
        articleDoc,
        learningItems,
        articleDocuments,
        conversations,
        messages,
        messagesByConversation,
        vocabularyBooks: liveBooks.filter((book) => bookIds.has(book.id)),
        vocabularyEntries: liveEntries.filter((entry) => entryIds.has(entry.id)),
        vocabularyLinks
    };
}

function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"'\r]/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '\r': '&#13;'
    }[char]));
}

// markdownToHtml 自己跳脫 HTML；只解一層，隨後一律重新跳脫文字／屬性。
function decodeEntities(value) {
    return String(value).replace(/&(?:amp|lt|gt|quot|apos|#(?:\d+|x[\da-f]+));/gi, (entity) => {
        const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
        const normalized = entity.toLowerCase();
        if (named[normalized]) return named[normalized];
        const hex = normalized.startsWith('&#x');
        const number = parseInt(normalized.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
        return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)
            ? String.fromCodePoint(number) : '�';
    });
}

function safeLink(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!/^(?:https?:\/\/|mailto:|tel:)/i.test(raw) || /[\u0000- \u007f\\]/.test(raw)) return '';
    try {
        const decoded = decodeURIComponent(raw);
        if (/[\u0000-\u001f\u007f\\]/.test(decoded)
            || /(?:\bBearer\s+|\bsk-(?:proj-)?[\w-]{12,}|\beyJ[\w-]+\.[\w-]+\.[\w-]+)/i.test(decoded)
            || [...decoded.matchAll(/(?:[?&#;]|^)([^?&#;=]+)=/g)].some((match) => CREDENTIAL_KEY.test(match[1]))) return '';
        const url = new URL(raw);
        if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol) || url.username || url.password) return '';
        if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.hostname) return '';
        const fragmentParams = new URLSearchParams(url.hash.slice(1).replace(/^\?/, ''));
        if ([...url.searchParams.keys(), ...fragmentParams.keys()].some((key) => CREDENTIAL_KEY.test(key))) return '';
        return url.href;
    } catch (_) {
        return '';
    }
}

function externalLink(url, label) {
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
}

function replaceMarkdownImages(markdown) {
    let fenced = false;
    const replace = (text) => text.replace(/!\[([^\]\n]*)\]\([^\)\n]*\)/g, (_match, name) => (
        t('article.editionImageOmitted', { name: name || '—' })
    ));
    return String(markdown == null ? '' : markdown).split('\n').map((line) => {
        if (/^\s*```/.test(line)) {
            fenced = !fenced;
            return line;
        }
        if (fenced) return line;
        // 例子中的行內程式碼保留原字面內容；真正圖片則只保留說明及後續文字。
        return line.split(/(`[^`]+`)/g).map((part, index) => index % 2 ? part : replace(part)).join('');
    }).join('\n');
}

/** 不把未消毒 HTML 放入 DOM；只重建明確允許的標籤和已檢查的連結。 */
function safeMarkdown(value) {
    const converted = markdownToHtml(replaceMarkdownImages(value));
    const tokens = /<\/?[a-z][^>]*>/gi;
    const stack = [];
    const output = [];
    const closeThrough = (index) => {
        while (stack.length > index) {
            const frame = stack.pop();
            if (frame.emitted) output.push(`</${frame.tag}>`);
        }
    };
    let offset = 0;
    for (const match of converted.matchAll(tokens)) {
        output.push(escapeHtml(decodeEntities(converted.slice(offset, match.index))));
        offset = match.index + match[0].length;
        const token = match[0];
        const tag = token.match(/^<\/?([a-z][\da-z]*)/i)?.[1].toLowerCase();
        if (tag === 'img') {
            const alt = token.match(/\balt="([^"]*)"/i)?.[1] || '—';
            output.push(`<span class="image-omitted">${escapeHtml(t('article.editionImageOmitted', { name: decodeEntities(alt) }))}</span>`);
            continue;
        }
        if (!MARKDOWN_TAGS.has(tag)) continue;
        if (token.startsWith('</')) {
            const index = stack.map((frame) => frame.tag).lastIndexOf(tag);
            if (index >= 0) closeThrough(index);
            continue;
        }
        if (tag === 'hr' || tag === 'br') {
            output.push(`<${tag}>`);
            continue;
        }
        if (tag === 'a') {
            const priorLink = stack.map((frame) => frame.tag).lastIndexOf('a');
            if (priorLink >= 0) closeThrough(priorLink);
            const href = token.match(/\bhref="([^"]*)"/i)?.[1];
            const safe = safeLink(decodeEntities(href || ''));
            if (safe) output.push(`<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">`);
            stack.push({ tag, emitted: !!safe });
        } else {
            output.push(`<${tag}>`);
            stack.push({ tag, emitted: true });
        }
    }
    output.push(escapeHtml(decodeEntities(converted.slice(offset))));
    closeThrough(0);
    return output.join('');
}

function formattedTime(value) {
    if (!value) return escapeHtml(t('article.readingUnknownTime'));
    try {
        const formatted = formatDateTime(value);
        if (formatted) return `<time datetime="${escapeHtml(new Date(value).toISOString())}">${escapeHtml(formatted)}</time>`;
    } catch (_) { /* 無效時間不可被當成實際查閱／開啟時間。 */ }
    return escapeHtml(t('article.readingUnknownTime'));
}

function field(label, value, { markdown = true } = {}) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    return `<div class="explanation-field"><h5>${escapeHtml(t(label))}</h5><div class="markdown">${markdown ? safeMarkdown(value) : escapeHtml(value)}</div></div>`;
}

function renderAlignment(entries) {
    const pairs = asArray(entries).map((entry) => {
        if (typeof entry === 'string') return `<li>${safeMarkdown(entry)}</li>`;
        if (!isRecord(entry)) return '';
        const original = entry.en || entry.english || entry.text || entry.source || '';
        const translated = entry.zh || entry.chinese || entry.translation || entry.target || '';
        if (!original && !translated) return '';
        return `<li><div>${escapeHtml(original)}</div><div class="translation">${escapeHtml(translated)}</div>${entry.note ? `<div class="markdown">${safeMarkdown(entry.note)}</div>` : ''}</li>`;
    }).join('');
    return pairs ? `<div class="explanation-field"><h5>${escapeHtml(t('article.editionAlignment'))}</h5><ul class="alignment">${pairs}</ul></div>` : '';
}

function renderExamples(entries) {
    const examples = asArray(entries).map((entry) => {
        if (typeof entry === 'string') return `<li class="markdown">${safeMarkdown(entry)}</li>`;
        if (!isRecord(entry)) return '';
        const original = entry.en || entry.english || entry.text || '';
        const translated = entry.zh || entry.chinese || entry.translation || '';
        return `<li><div class="example-original">${escapeHtml(original)}</div>${translated ? `<div class="translation">${escapeHtml(translated)}</div>` : ''}${entry.note ? `<div class="markdown">${safeMarkdown(entry.note)}</div>` : ''}${renderAlignment(entry.alignment)}</li>`;
    }).join('');
    return examples ? `<div class="explanation-field"><h5>${escapeHtml(t('article.editionExamples'))}</h5><ol class="examples">${examples}</ol></div>` : '';
}

function renderExplanation(item) {
    const result = item.explanation?.result;
    if (typeof result === 'string') return `<div class="markdown saved-explanation">${safeMarkdown(result)}</div>`;
    if (!isRecord(result)) return `<p class="muted">${escapeHtml(t('article.readingNoExplanation'))}</p>`;
    const fields = [
        ['phonetic', 'article.editionPhonetic', false],
        ['pos', 'article.editionPartOfSpeech', false],
        ['meaning', 'article.readingMeaning'],
        ['translation', 'article.readingTranslation'],
        ['chinese_translation', 'article.readingTranslation'],
        ['usage', 'article.readingUsage'],
        ['role', 'article.roleLabel'],
        ['definition', 'article.editionExplanation'],
        ['explanation', 'article.editionExplanation'],
        ['note', 'article.editionExplanation'],
        ['text', 'article.editionExplanation']
    ];
    const renderGroup = (group) => {
        if (typeof group === 'string') return `<div class="markdown">${safeMarkdown(group)}</div>`;
        if (!isRecord(group)) return '';
        const basics = fields.map(([key, label, markdown = true]) => field(label, group[key], { markdown })).join('');
        const chunks = asArray(group.chunks).map((chunk) => {
            if (typeof chunk === 'string') return `<li class="markdown">${safeMarkdown(chunk)}</li>`;
            if (!isRecord(chunk)) return '';
            return `<li>${chunk.text ? `<div class="chunk-text">${escapeHtml(chunk.text)}</div>` : ''}${chunk.role ? `<div class="chunk-role">${escapeHtml(chunk.role)}</div>` : ''}${chunk.note ? `<div class="markdown">${safeMarkdown(chunk.note)}</div>` : ''}${field('article.readingTranslation', chunk.translation)}${field('article.editionExplanation', chunk.explanation)}</li>`;
        }).join('');
        const points = asArray(group.key_points || group.keyPoints).map((point) => {
            if (typeof point === 'string') return `<li class="markdown">${safeMarkdown(point)}</li>`;
            if (!isRecord(point)) return '';
            return `<li>${field('article.editionKeyPoints', point.text || point.point)}${field('article.editionExplanation', point.note || point.explanation)}</li>`;
        }).join('');
        return basics + renderExamples(group.examples) + renderAlignment(group.phrase_alignment || group.alignment)
            + (chunks ? `<div class="explanation-field"><h5>${escapeHtml(t('article.editionChunks'))}</h5><ol class="chunks">${chunks}</ol></div>` : '')
            + (points ? `<div class="explanation-field"><h5>${escapeHtml(t('article.editionKeyPoints'))}</h5><ul>${points}</ul></div>` : '');
    };
    const context = result.sentence && result.sentence !== item.sentence && result.sentence !== item.anchor?.quote
        ? field('article.editionContext', result.sentence, { markdown: false }) : '';
    const explanation = context + renderGroup(result.analysis) + renderGroup(result);
    return explanation || `<p class="muted">${escapeHtml(t('article.readingNoExplanation'))}</p>`;
}

function isPlaceable(item, body, version) {
    const anchor = item.anchor;
    return item.contentVersion === version && item.positionUncertain === false && isRecord(anchor)
        && typeof anchor.quote === 'string' && anchor.quote.length > 0
        && Number.isInteger(anchor.start) && Number.isInteger(anchor.end)
        && anchor.start >= 0 && anchor.end > anchor.start && anchor.end <= body.length
        && anchor.end - anchor.start === anchor.quote.length
        && body.slice(anchor.start, anchor.end) === anchor.quote;
}

function renderOriginal(body, records) {
    const starts = new Map();
    const ends = new Map();
    for (const record of records.filter((entry) => entry.placed)) {
        const { start, end } = record.item.anchor;
        if (!starts.has(start)) starts.set(start, []);
        if (!ends.has(end)) ends.set(end, []);
        starts.get(start).push(record);
        ends.get(end).push(record);
    }
    const boundaries = [...new Set([0, body.length, ...starts.keys(), ...ends.keys()])].sort((a, b) => a - b);
    const active = new Map();
    const output = [];
    for (let index = 0; index < boundaries.length; index += 1) {
        const position = boundaries[index];
        for (const record of ends.get(position) || []) {
            active.delete(record.number);
            output.push(`<a class="text-reference" href="#${record.id}" data-number="${record.number}" aria-label="${escapeHtml(t('article.editionItemLink', { number: record.number }))}" title="${escapeHtml(t('article.editionItemLink', { number: record.number }))}"></a>`);
        }
        for (const record of starts.get(position) || []) {
            active.set(record.number, record);
            output.push(`<span class="origin-target" id="${record.originId}" tabindex="-1"></span>`);
        }
        const next = boundaries[index + 1];
        if (next === undefined || next === position) continue;
        const text = escapeHtml(body.slice(position, next));
        if (!active.size) {
            output.push(`<span class="original-fragment">${text}</span>`);
        } else {
            const first = active.values().next().value;
            output.push(`<a class="original-fragment text-mark${active.size > 1 ? ' overlap-mark' : ''}" href="#${first.id}" title="${escapeHtml(t('article.editionItemLink', { number: first.number }))}">${text}</a>`);
        }
    }
    return output.join('');
}

function validatedAudio(audioTracks) {
    if (!Array.isArray(audioTracks) || audioTracks.length > 5) throw new Error('invalid_audio');
    let total = 0;
    return audioTracks.map((track) => {
        if (!isRecord(track) || !AUDIO_TYPES.has(track.type) || typeof track.dataUrl !== 'string') throw new Error('invalid_audio');
        const match = track.dataUrl.match(/^data:(audio\/[a-z0-9]+);base64,/i);
        if (!match || match[1].toLowerCase() !== track.type) throw new Error('invalid_audio');
        const payload = track.dataUrl.slice(match[0].length);
        const padding = payload.endsWith('==') ? 2 : (payload.endsWith('=') ? 1 : 0);
        const size = payload.length * 3 / 4 - padding;
        if (!payload.length || payload.length % 4 || (track.size !== undefined && track.size !== size)) throw new Error('invalid_audio');
        total += size;
        if (total > 25 * 1024 * 1024 || /[^a-z0-9+/]/i.test(payload.slice(0, payload.length - padding))) throw new Error('invalid_audio');
        return { name: String(track.name || ''), type: track.type, dataUrl: track.dataUrl };
    });
}

function statusNotice(entity) {
    const status = String(entity.status || '').toLowerCase();
    if (status === 'cancelled' || status === 'canceled') {
        return `<p class="status-notice status-cancelled">${escapeHtml(t('assistant.streamCancelled'))}</p>`;
    }
    return status && !['complete', 'completed'].includes(status)
        ? `<p class="status-notice status-incomplete">${escapeHtml(t('article.editionIncomplete'))}</p>` : '';
}

const STYLES = `
:root{color-scheme:light;--page:#f4f3ee;--paper:#fffefa;--ink:#24323b;--muted:#627078;--line:#dce0dd;--accent:#245b61;--mark:#fff0c9;--warn:#755422;--radius:16px}
*{box-sizing:border-box}html{scroll-padding-top:24px}body{margin:0;background:var(--page);color:var(--ink);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.7;overflow-wrap:anywhere}a{color:var(--accent);text-underline-offset:.2em}a:hover{text-decoration-thickness:2px}a:focus-visible{outline:3px solid #9b6a19;outline-offset:4px;border-radius:3px}h1,h2,h3,h4,h5,p,blockquote,figure,dl{margin:0}h1,h2,h3,h4,h5{line-height:1.35;text-wrap:balance}h1{font-size:clamp(1.8rem,4vw,3rem);letter-spacing:-.035em}h2{font-size:1.3rem}h3{font-size:1.13rem}h4{font-size:1.04rem}h5{font-size:.8rem;font-weight:650;color:var(--muted);margin-bottom:.3rem}p+p{margin-top:.75rem}ul,ol{padding-left:1.4rem}li+li{margin-top:.4rem}button,input,textarea,select{font:inherit}main,section,article,aside{min-width:0}:target{scroll-margin-top:24px}.shell{width:min(1240px,100%);margin:auto;padding:36px 32px 64px}.edition-header{padding:8px 0 30px;border-bottom:1px solid var(--line);margin-bottom:28px}.eyebrow{font-size:.76rem;font-weight:700;letter-spacing:.12em;color:var(--accent);margin-bottom:12px}.header-meta{display:flex;flex-wrap:wrap;gap:8px 28px;margin-top:22px;font-size:.84rem;color:var(--muted)}.header-meta>div{min-width:0}.header-meta dt{display:inline;margin-right:.5rem}.header-meta dd{display:inline;margin:0}.header-meta code{font-size:.8rem}.edition-layout{display:grid;grid-template-columns:190px minmax(0,1fr);gap:32px;align-items:start}.edition-nav{position:sticky;top:24px;font-size:.85rem}.edition-nav h2{font-size:.76rem;font-weight:700;letter-spacing:.06em;margin:0 0 12px;color:var(--muted)}.edition-nav ol{list-style:none;margin:0;padding:0}.edition-nav li+li{margin-top:3px}.edition-nav a{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:8px 10px;border-radius:7px;text-decoration:none}.edition-nav a:hover{background:#e7ece7}.nav-count{font-size:.75rem;color:var(--muted);font-variant-numeric:tabular-nums}.nav-snapshot{font-size:.75rem;color:var(--muted);border-top:1px solid var(--line);margin-top:20px;padding:16px 10px}.section{margin-bottom:28px}.paper{padding:clamp(20px,3.2vw,40px);border:1px solid var(--line);border-radius:var(--radius);background:var(--paper)}.section-heading{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin-bottom:20px}.section-heading .count{font-size:.85rem;color:var(--muted);font-weight:400}.guide,.muted,.empty{color:var(--muted)}.guide{font-size:.86rem;margin-bottom:24px}.original-text{font-family:ui-serif,Georgia,"Times New Roman",serif;font-size:1.14rem;line-height:2;white-space:pre-wrap;tab-size:4}.text-mark{color:inherit;background:var(--mark);text-decoration:underline;text-decoration-color:#bd9138;text-decoration-thickness:1px;box-decoration-break:clone;-webkit-box-decoration-break:clone}.overlap-mark{background:#ffe3a6;text-decoration-style:double}.text-mark:hover{background:#ffdfa0}.text-reference{display:inline-block;vertical-align:super;line-height:1.5;min-width:1.5em;margin:0 .1em;padding:0 .2em;border:1px solid #c9a55a;border-radius:5px;background:#fff6df;color:#70501c;font:600 .66em/1.6 system-ui,sans-serif;text-align:center;text-decoration:none;white-space:normal;user-select:none}.text-reference::after{content:attr(data-number)}.origin-target{position:relative;scroll-margin-top:36px}.origin-target:target::before{content:"";position:absolute;inset:-.25em -.12em;outline:3px solid #245b61;border-radius:3px}.scope-notice{font-size:.87rem;background:#eaf0eb;border:1px solid #d4e1d5;border-radius:12px;padding:18px 22px;margin-bottom:24px}.scope-notice h2{font-size:.9rem;margin-bottom:8px}.scope-notice ul{margin:.8rem 0 0;padding-left:1.2rem}.scope-notice li{color:#665229}.records{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.learning-card,.document-card,.conversation,.audio-card{background:var(--paper);border:1px solid var(--line);border-radius:var(--radius);padding:24px;min-width:0}.learning-card:target,.document-card:target,.message:target{outline:3px solid #b58b3a;outline-offset:3px;background:#fffaf0}.card-topline{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:10px}.record-number{font-variant-numeric:tabular-nums;color:var(--accent);font-size:.8rem;font-weight:750;margin-right:3px}.badge{display:inline-block;font-size:.7rem;line-height:1.5;padding:3px 7px;border-radius:5px;background:#edf0ed;color:#4c5f58}.badge-marked{background:#f8e9bf;color:#73551e}.badge-detached{background:#fae8db;color:#854e28}.learning-card h3{white-space:pre-wrap;margin-bottom:18px}.item-context{white-space:pre-wrap;border-left:3px solid #d3dcd5;padding-left:12px;color:var(--muted);font-size:.88rem;margin-bottom:18px}.saved-explanation{margin-bottom:18px}.explanation-field{margin-top:15px}.explanation-field:first-child{margin-top:0}.explanation-field .markdown{font-size:.92rem}.translation{color:var(--muted);margin-top:3px}.examples,.chunks,.alignment{font-size:.9rem;margin:8px 0 0}.examples li,.chunks li{padding:2px 0 7px}.example-original,.chunk-text{white-space:pre-wrap}.chunk-role{font-size:.78rem;color:var(--accent);margin-top:3px}.alignment{list-style:none;padding:0;border-top:1px solid var(--line)}.alignment li{padding:8px 0;border-bottom:1px solid var(--line)}.item-note{margin-top:20px;padding:16px;border-radius:9px;background:#f2f4ec;border:1px solid #e3e8d9}.item-note h4{font-size:.83rem;color:#4a624c;margin-bottom:9px}.item-meta{font-size:.75rem;color:var(--muted);border-top:1px solid var(--line);padding-top:14px;margin-top:20px;display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 12px}.item-meta dd{margin:0}.vocabulary{font-size:.82rem;margin-top:18px}.vocabulary h4{font-size:.76rem;color:var(--muted)}.vocabulary ul{margin:.4rem 0 0;padding-left:1.2rem}.card-footer{margin-top:18px;font-size:.79rem;display:flex;flex-wrap:wrap;gap:10px 22px}.detached-hint{font-size:.87rem;color:var(--muted);margin-bottom:16px}.document-card+.document-card,.conversation+.conversation,.audio-card+.audio-card{margin-top:16px}.document-meta{font-size:.77rem;color:var(--muted);margin:8px 0 20px}.markdown{font-size:.95rem;line-height:1.8;white-space:normal;overflow-wrap:anywhere}.markdown p{white-space:pre-wrap}.markdown h1,.markdown h2,.markdown h3,.markdown h4,.markdown h5,.markdown h6{font-size:1.1em;color:var(--ink);margin:1.15em 0 .5em}.markdown> :first-child{margin-top:0}.markdown> :last-child{margin-bottom:0}.markdown ul,.markdown ol{margin:.6em 0}.markdown blockquote{margin:1em 0;border-left:3px solid #b9cdc0;padding:8px 14px;background:#f2f6f0}.markdown pre{max-width:100%;overflow-x:auto;white-space:pre;padding:14px;border-radius:8px;background:#eff1ed;font-size:.82em;line-height:1.65}.markdown code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}.markdown table{display:block;max-width:100%;overflow-x:auto;border-collapse:collapse;margin:1em 0;font-size:.88em}.markdown th,.markdown td{text-align:left;border:1px solid var(--line);padding:8px 11px;min-width:80px}.markdown hr{border:0;border-top:1px solid var(--line);margin:1.5em 0}.sources{border-top:1px solid var(--line);margin-top:22px;padding-top:16px;font-size:.82rem}.sources h4{font-size:.78rem;color:var(--muted);margin-bottom:8px}.sources ul{margin:.4rem 0 .8rem}.source-unavailable{color:#88664b}.message{padding:20px 0;border-top:1px solid var(--line)}.message:first-of-type{margin-top:18px}.message-header{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:4px 16px;margin-bottom:10px}.message-role{font-weight:700;font-size:.85rem}.message-time{font-size:.75rem;color:var(--muted)}.message-user{border-left:3px solid #c8d8c5;padding-left:15px}.status-notice{font-size:.8rem;color:#8b5a2e;background:#fff2df;border:1px solid #ead8ba;border-radius:7px;padding:8px 12px;margin:12px 0}.image-omitted{color:var(--muted);font-style:italic}.audio-hint{font-size:.87rem;color:var(--muted);margin-bottom:18px}.audio-card figcaption{font-weight:650;font-size:.92rem;margin-bottom:14px;white-space:pre-wrap}.audio-card audio{display:block;width:100%;max-width:100%}.edition-footer{border-top:1px solid var(--line);margin-top:36px;padding-top:18px;font-size:.8rem;color:var(--muted);display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px}.empty{font-size:.9rem;padding:20px 0}.source-value a{word-break:break-word}
@media(min-width:1100px){.records .learning-card:only-child{grid-column:1/-1}}@media(max-width:900px){.edition-layout{grid-template-columns:150px minmax(0,1fr);gap:24px}.records{grid-template-columns:minmax(0,1fr)}.shell{padding:28px 24px 48px}}@media(max-width:650px){.shell{padding:20px 14px 36px}.edition-header{padding-bottom:22px;margin-bottom:18px}.header-meta{gap:8px 20px;font-size:.78rem}.edition-layout{display:block}.edition-nav{position:static;margin-bottom:22px}.edition-nav ol{display:flex;flex-wrap:wrap;gap:5px}.edition-nav li+li{margin:0}.edition-nav a{padding:6px 9px;border:1px solid var(--line);background:var(--paper);font-size:.76rem}.edition-nav h2{margin-bottom:10px}.nav-snapshot{display:none}.scope-notice{padding:16px;font-size:.81rem}.paper,.learning-card,.document-card,.conversation,.audio-card{padding:20px 17px;border-radius:12px}.original-text{font-size:1.065rem;line-height:2}.text-reference{min-width:1.65em;line-height:1.8}.section-heading{margin-bottom:16px}.section{margin-bottom:24px}.item-meta{grid-template-columns:minmax(0,1fr);gap:1px}.item-meta dd+dt{margin-top:6px}.markdown{font-size:.91rem}.item-note{padding:13px}.message-header{display:block}.message-time{margin-top:3px}.edition-footer{font-size:.76rem}}
@media print{body{background:#fff}.shell{width:100%;padding:0}.edition-layout{display:block}.edition-nav{position:static}.edition-nav ol{display:flex;gap:12px;flex-wrap:wrap}.nav-snapshot{display:none}.paper,.learning-card,.document-card,.conversation{break-inside:avoid;box-shadow:none}.records{grid-template-columns:minmax(0,1fr)}.original-text{font-size:11pt}.audio-card audio{display:none}.edition-footer{break-inside:avoid}}
`;

/** 同步、無網絡／儲存讀寫的呈現入口。 */
export function renderReadingEdition({
    snapshot,
    articleId,
    includeChat = true,
    audioTracks = [],
    exportedAt = new Date().toISOString()
} = {}) {
    if (snapshot?.ok === false) throw new Error('snapshot_failed');
    const selected = selectArticleReading(snapshot, articleId);
    const article = selected.articleDoc;
    if (!article) throw new Error('article_not_found');
    const audio = validatedAudio(audioTracks);
    const body = String(article.body == null ? '' : article.body);
    const title = String(article.title || t('article.untitled'));
    const version = contentVersionOf(body);
    const records = selected.learningItems.map((item, index) => ({
        item,
        number: index + 1,
        id: `learning-${index + 1}`,
        originId: `original-item-${index + 1}`,
        placed: isPlaceable(item, body, version)
    }));
    const recordsById = new Map(records.filter((record) => hasId(record.item.id)).map((record) => [record.item.id, record]));
    const conversations = includeChat ? selected.conversations : [];
    const messages = includeChat ? selected.messages : [];
    const messageRecords = messages.map((message, index) => ({ message, number: index + 1, id: `message-${index + 1}` }));
    const messagesById = new Map(messageRecords.filter((record) => hasId(record.message.id)).map((record) => [record.message.id, record]));
    const messageNavigation = new Map(messageRecords.map((record) => [record.message, record]));
    const booksById = new Map(selected.vocabularyBooks.map((book) => [book.id, book]));
    const entriesById = new Map(selected.vocabularyEntries.map((entry) => [entry.id, entry]));
    const linksByItem = new Map();
    for (const link of selected.vocabularyLinks) {
        if (!linksByItem.has(link.itemId)) linksByItem.set(link.itemId, []);
        linksByItem.get(link.itemId).push(link);
    }
    const words = records.filter((record) => record.placed && record.item.kind !== 'sentence');
    const sentences = records.filter((record) => record.placed && record.item.kind === 'sentence');
    const detached = records.filter((record) => !record.placed);
    const noteDocs = selected.articleDocuments.filter((doc) => doc.kind !== 'ai');
    const aiDocs = selected.articleDocuments.filter((doc) => doc.kind === 'ai');
    const states = [selected.readingState, selected.articleState].filter(isRecord);
    const errors = !!(selected.readError || selected.persistenceError || states.some((state) => state.lastError || state.readError || state.persistenceError));
    const conflictCount = states.reduce((count, state) => count + Object.values(state.conflicts || {}).filter(Boolean).length, 0);
    const positiveCount = (value) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;
    const pendingChanges = positiveCount(selected.articleOutboxCount) + positiveCount(selected.readingOutboxCount) > 0
        || [article, ...selected.learningItems, ...selected.articleDocuments, ...selected.conversations, ...selected.messages,
            ...selected.vocabularyBooks, ...selected.vocabularyEntries, ...selected.vocabularyLinks]
            .some((entity) => entity.pending || entity.dirty)
        || states.some((state) => state.pending || state.dirty);
    const pending = pendingChanges || errors;
    const meta = {
        articleId,
        title,
        contentVersion: version,
        exportedAt,
        itemCount: records.length,
        documentCount: selected.articleDocuments.length,
        conversationCount: conversations.length,
        messageCount: messages.length,
        audioCount: audio.length,
        detachedCount: detached.length,
        conflictCount,
        pending: !!pending
    };
    const kindLabel = (kind) => t(kind === 'sentence' ? 'article.readingKindSentence'
        : (kind === 'phrase' ? 'article.readingKindPhrase' : 'article.readingKindWord'));
    const itemLink = (record, className = 'source-link') => `<a class="${className}" href="#${record.id}">${escapeHtml(t('article.editionSourceItem', { number: record.number }))} · ${escapeHtml(record.item.anchor?.quote || record.item.sentence || kindLabel(record.item.kind))}</a>`;
    const renderItem = (record) => {
        const item = record.item;
        const understandingKey = {
            unmarked: 'article.editionUnderstandingUnmarked',
            needs_review: 'article.editionUnderstandingReview',
            understood: 'article.editionUnderstandingUnderstood'
        }[item.understanding];
        const linked = (linksByItem.get(item.id) || []).map((link) => {
            const entry = entriesById.get(link.entryId);
            const book = booksById.get(link.bookId);
            return `<li>${escapeHtml(entry.word || item.anchor?.quote || '')} · ${escapeHtml(book.name || '—')}</li>`;
        }).join('');
        return `<article class="learning-card${record.placed ? '' : ' is-detached'}" id="${record.id}">
<div class="card-topline"><span class="record-number">#${record.number}</span><span class="badge">${escapeHtml(kindLabel(item.kind))}</span><span class="badge${item.marked === true ? ' badge-marked' : ''}">${escapeHtml(t(item.marked === true ? 'article.readingMarkedYes' : 'article.readingMarkedNo'))}</span>${record.placed ? '' : `<span class="badge badge-detached">${escapeHtml(t('article.editionDetached'))}</span>`}</div>
<h3>${escapeHtml(item.anchor?.quote || item.sentence || kindLabel(item.kind))}</h3>
${item.sentence && item.sentence !== item.anchor?.quote ? `<blockquote class="item-context">${escapeHtml(item.sentence)}</blockquote>` : ''}
<div class="saved-explanation">${renderExplanation(item)}</div>
${typeof item.note === 'string' && item.note ? `<section class="item-note"><h4>${escapeHtml(t('article.readingNote'))}</h4><div class="markdown">${safeMarkdown(item.note)}</div></section>` : ''}
${linked ? `<section class="vocabulary"><h4>${escapeHtml(t('article.readingSavedToBook'))}</h4><ul>${linked}</ul></section>` : ''}
<dl class="item-meta">${understandingKey ? `<dt>${escapeHtml(t('article.editionUnderstanding'))}</dt><dd>${escapeHtml(t(understandingKey))}</dd>` : ''}<dt>${escapeHtml(t('article.editionFirstViewed'))}</dt><dd>${formattedTime(item.firstViewedAt)}</dd><dt>${escapeHtml(t('article.editionLastViewed'))}</dt><dd>${formattedTime(item.lastViewedAt)}</dd></dl>
<div class="card-footer">${record.placed ? `<a class="back-to-text" href="#${record.originId}">${escapeHtml(t('article.editionBackToText'))}</a>` : `<span class="muted">${escapeHtml(t('article.readingPositionUncertain'))}</span>`}<a href="#edition-top">${escapeHtml(t('article.editionBackToTop'))}</a></div>
</article>`;
    };
    const renderSourceList = (ids, type) => {
        const entries = asArray(ids);
        if (!entries.length) return '';
        const heading = type === 'item' ? 'article.readingAiSourceItems' : 'article.readingAiSourceMessages';
        return `<div><h4>${escapeHtml(t(heading))}</h4><ul>${entries.map((id) => {
            if (type === 'item') {
                const record = recordsById.get(id);
                if (record) return `<li>${itemLink(record)}</li>`;
            } else {
                const record = messagesById.get(id);
                if (record) return `<li><a class="source-link" href="#${record.id}">${escapeHtml(t('article.editionSourceMessage', { number: record.number }))}</a></li>`;
            }
            return `<li class="source-unavailable">${escapeHtml(t('article.editionSourceUnavailable'))}</li>`;
        }).join('')}</ul></div>`;
    };
    const renderDocument = (doc) => {
        const sources = renderSourceList(doc.sourceItemIds, 'item') + renderSourceList(doc.sourceMessageIds, 'message');
        return `<article class="document-card"><h3>${escapeHtml(doc.title || t(doc.kind === 'ai' ? 'article.readingSectionAi' : 'article.readingArticleNote'))}</h3><div class="document-meta">${formattedTime(doc.updatedAt || doc.createdAt)}</div>${statusNotice(doc)}<div class="markdown">${safeMarkdown(doc.content || '')}</div>${sources ? `<section class="sources" aria-label="${escapeHtml(t('article.editionSources'))}">${sources}</section>` : ''}</article>`;
    };
    const renderMessage = (message) => {
        const record = messageNavigation.get(message);
        const sourceItem = recordsById.get(message.learningItemId);
        const role = t(message.role === 'user' ? 'article.readingChatUser'
            : (message.role === 'system' ? 'article.editionSystemMessage' : 'article.readingChatAssistant'));
        return `<article class="message${message.role === 'user' ? ' message-user' : ''}" id="${record.id}"><div class="message-header"><h4 class="message-role">${escapeHtml(role)}</h4><div class="message-time">${formattedTime(message.createdAt)}</div></div>${statusNotice(message)}<div class="markdown">${safeMarkdown(message.content || '')}</div>${message.learningItemId ? `<div class="sources">${sourceItem ? itemLink(sourceItem) : `<span class="source-unavailable">${escapeHtml(t('article.editionSourceUnavailable'))}</span>`}</div>` : ''}</article>`;
    };
    const chat = conversations.map((conv) => {
        const savedMessages = selected.messagesByConversation.get(conv.id) || [];
        return `<section class="conversation"><h3>${escapeHtml(conv.title || t('assistant.session'))}</h3>${savedMessages.length ? savedMessages.map(renderMessage).join('') : `<p class="empty">${escapeHtml(t('article.readingChatNotLoaded'))}</p>`}</section>`;
    }).join('');
    const empty = `<p class="empty">${escapeHtml(t('article.readingEmptySection'))}</p>`;
    const recordSection = (id, label, entries, hint = '') => `<section class="section" id="${id}" aria-labelledby="${id}-heading"><div class="section-heading"><h2 id="${id}-heading">${escapeHtml(t(label))}</h2><span class="count">${entries.length}</span></div>${hint ? `<p class="detached-hint">${escapeHtml(t(hint))}</p>` : ''}${entries.length ? `<div class="records">${entries.map(renderItem).join('')}</div>` : empty}</section>`;
    const docSection = (id, label, docs) => `<section class="section" id="${id}" aria-labelledby="${id}-heading"><div class="section-heading"><h2 id="${id}-heading">${escapeHtml(t(label))}</h2><span class="count">${docs.length}</span></div>${docs.length ? docs.map(renderDocument).join('') : empty}</section>`;
    const navigation = [
        ['original', 'article.readingSectionFullText', null],
        ['words', 'article.readingSectionWords', words.length],
        ['sentences', 'article.readingSectionSentences', sentences.length],
        ['detached', 'article.editionDetached', detached.length],
        ['article-notes', 'article.readingArticleNote', noteDocs.length],
        ['ai-documents', 'article.readingSectionAi', aiDocs.length],
        ...(includeChat ? [['chat', 'article.readingSectionChat', messages.length]] : []),
        ['audio', 'article.editionAudio', audio.length]
    ].map(([id, label, count]) => `<li><a href="#${id}"><span>${escapeHtml(t(label))}</span>${count === null ? '' : `<span class="nav-count">${count}</span>`}</a></li>`).join('');
    const sourceUrl = safeLink(article.sourceUrl);
    const sourceLabels = { url: 'article.sourceUrl', news: 'article.sourceUrl', file: 'article.sourceFile', library: 'article.sourceFile', ocr: 'article.sourceOcr', paste: 'article.sourcePaste' };
    const source = sourceUrl ? externalLink(sourceUrl, sourceUrl)
        : (article.sourceUrl ? escapeHtml(t('article.editionLinkOmitted')) : escapeHtml(sourceLabels[article.sourceType] ? t(sourceLabels[article.sourceType]) : '—'));
    const caveats = [
        pendingChanges ? t('article.readingExportCaveatPending') : '',
        errors ? t('article.editionSyncError') : '',
        conflictCount ? t('article.readingExportCaveatConflicts', { count: conflictCount }) : '',
        detached.length ? t('article.readingExportCaveatPosition', { count: detached.length }) : ''
    ].filter(Boolean);
    const html = `<!doctype html>
<html lang="${escapeHtml(getLocaleTag())}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; media-src data:; connect-src 'none'; font-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)} · ${escapeHtml(t('article.editionTitle'))}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="shell" id="edition-top">
<header class="edition-header"><p class="eyebrow">${escapeHtml(t('article.editionTitle'))}</p><h1>${escapeHtml(title)}</h1><dl class="header-meta"><div class="source-value"><dt>${escapeHtml(t('article.readingExportSource'))}</dt><dd>${source}</dd></div><div><dt>${escapeHtml(t('article.readingExportTime'))}</dt><dd>${formattedTime(exportedAt)}</dd></div><div><dt>${escapeHtml(t('article.readingExportVersion'))}</dt><dd><code>${escapeHtml(version)}</code></dd></div>${article.lastOpenedAt ? `<div><dt>${escapeHtml(t('article.editionLastOpened'))}</dt><dd>${formattedTime(article.lastOpenedAt)}</dd></div>` : ''}</dl></header>
<div class="edition-layout">
<aside class="edition-nav"><nav aria-label="${escapeHtml(t('article.editionNavigation'))}"><h2>${escapeHtml(t('article.editionNavigation'))}</h2><ol>${navigation}</ol></nav><p class="nav-snapshot">${escapeHtml(t('article.editionLocalSnapshot'))}</p></aside>
<main>
<aside class="scope-notice" aria-labelledby="snapshot-heading"><h2 id="snapshot-heading">${escapeHtml(t('article.editionLocalSnapshot'))}</h2><p>${escapeHtml(t('article.editionScopeNotice'))}</p>${caveats.length ? `<ul>${caveats.map((caveat) => `<li>${escapeHtml(caveat)}</li>`).join('')}</ul>` : ''}</aside>
<section class="section paper" id="original" aria-labelledby="original-heading"><div class="section-heading"><h2 id="original-heading">${escapeHtml(t('article.readingSectionFullText'))}</h2></div><p class="guide">${escapeHtml(t('article.editionReadingGuide'))}</p><div class="original-text" id="original-text">${renderOriginal(body, records)}</div></section>
${recordSection('words', 'article.readingSectionWords', words)}
${recordSection('sentences', 'article.readingSectionSentences', sentences)}
${recordSection('detached', 'article.editionDetached', detached, detached.length ? 'article.editionDetachedHint' : '')}
${docSection('article-notes', 'article.readingArticleNote', noteDocs)}
${docSection('ai-documents', 'article.readingSectionAi', aiDocs)}
${includeChat ? `<section class="section" id="chat" aria-labelledby="chat-heading"><div class="section-heading"><h2 id="chat-heading">${escapeHtml(t('article.readingSectionChat'))}</h2><span class="count">${messages.length}</span></div>${chat || empty}</section>` : ''}
<section class="section" id="audio" aria-labelledby="audio-heading"><div class="section-heading"><h2 id="audio-heading">${escapeHtml(t('article.editionAudio'))}</h2><span class="count">${audio.length}</span></div><p class="audio-hint">${escapeHtml(t(audio.length ? 'article.editionAudioHint' : 'article.editionNoAudio'))}</p>${audio.map((track) => `<figure class="audio-card"><figcaption>${escapeHtml(track.name || t('article.editionAudio'))}</figcaption><audio controls preload="none" aria-label="${escapeHtml(track.name || t('article.editionAudio'))}"><source src="${escapeHtml(track.dataUrl)}" type="${escapeHtml(track.type)}"></audio></figure>`).join('')}</section>
</main>
</div>
<footer class="edition-footer"><span>${escapeHtml(t('article.editionLocalSnapshot'))} · ${formattedTime(exportedAt)}</span><a href="#edition-top">${escapeHtml(t('article.editionBackToTop'))}</a></footer>
</div>
</body>
</html>`;
    return { html, meta };
}
