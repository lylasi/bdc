// 學習記錄的同一份篩選、搜尋、排序與計數，供面板各入口共用。
export const READING_FILTERS = ['all', 'words', 'sentences', 'marked', 'notes', 'ai'];

export function readingMeaning(item) {
    const result = item?.explanation?.result;
    return String(result?.analysis?.meaning || result?.meaning || result?.translation || (typeof result === 'string' ? result : '') || '').trim();
}

export function selectReadingRecords({ items = [], documents = [], filter = 'all', savedOnly = false, query = '', sort = 'source', isSaved = () => false } = {}) {
    const needle = String(query).trim().toLocaleLowerCase();
    const records = [
        ...items.filter(item => !item.deletedAt).map(entity => ({ type: 'item', entity })),
        ...documents.filter(doc => !doc.deletedAt).map(entity => ({ type: 'document', entity }))
    ];
    const matches = (record, key) => {
        const { type, entity } = record;
        if (key === 'all') return true;
        if (type === 'document') return (key === 'ai' && entity.kind === 'ai') || (key === 'notes' && entity.kind === 'note');
        if (key === 'words') return entity.kind === 'word' || entity.kind === 'phrase';
        if (key === 'sentences') return entity.kind === 'sentence';
        if (key === 'marked') return entity.marked === true;
        if (key === 'notes') return !!String(entity.note || '').trim();
        return false;
    };
    const candidates = records.filter(({ type, entity }) => {
        if (savedOnly && (type !== 'item' || !isSaved(entity.id))) return false;
        if (!needle) return true;
        return [entity.anchor?.quote, entity.sentence, readingMeaning(entity), entity.note, entity.title, entity.content]
            .some(value => String(value || '').toLocaleLowerCase().includes(needle));
    });
    const counts = Object.fromEntries(READING_FILTERS.map(key => [key, candidates.filter(record => matches(record, key)).length]));
    const visible = candidates.filter(record => matches(record, filter));
    visible.sort((left, right) => {
        const a = left.entity;
        const b = right.entity;
        if (sort !== 'source') {
            const field = sort === 'viewed' ? 'lastViewedAt' : 'updatedAt';
            const time = String(b[field] || '').localeCompare(String(a[field] || ''));
            if (time) return time;
        }
        if (left.type !== right.type) return left.type === 'item' ? -1 : 1;
        if (left.type === 'document') return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
        const position = entity => entity.positionUncertain || !(Number(entity.anchor?.start) >= 0) ? Infinity : Number(entity.anchor.start);
        const av = position(a);
        const bv = position(b);
        if (av !== bv) return av < bv ? -1 : 1;
        return String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id));
    });
    return { records: visible, counts, total: records.length };
}
