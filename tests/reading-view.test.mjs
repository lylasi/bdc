import test from 'node:test';
import assert from 'node:assert/strict';
import { selectReadingRecords } from '../features/article/reading-view.js';

const items = [
    { id: 'phrase', kind: 'phrase', anchor: { quote: 'look forward to', start: 3 }, note: '接动名词', marked: true, lastViewedAt: '2026-10-20', updatedAt: '2026-10-21' },
    { id: 'sentence', kind: 'sentence', anchor: { quote: 'Please review this.', start: 30 }, note: '请求', lastViewedAt: '2026-10-22', updatedAt: '2026-10-22' },
    { id: 'unknown', kind: 'word', anchor: { quote: 'unknown', start: -1 }, updatedAt: '2026-10-23' },
    { id: 'deleted', kind: 'word', deletedAt: '2026-10-22', anchor: { quote: 'gone', start: 0 } }
];
const documents = [
    { id: 'ai', kind: 'ai', title: 'AI notes', content: 'look forward to usage', updatedAt: '2026-10-24' },
    { id: 'note', kind: 'note', title: '全篇笔记', content: '请求语气', updatedAt: '2026-10-23' }
];
const options = { items, documents, isSaved: id => id === 'phrase' };

test('全部與有筆記包含全篇文件，刪除項不計數', () => {
    const view = selectReadingRecords(options);
    assert.equal(view.counts.all, 5);
    assert.equal(view.counts.notes, 3);
    assert.equal(view.counts.ai, 1);
    assert.equal(view.total, 5);
    assert.deepEqual(view.records.slice(0, 3).map(record => record.entity.id), ['phrase', 'sentence', 'unknown']);
});

test('收藏與搜尋同時作用於清單和計數，文件不冒充收藏項', () => {
    const view = selectReadingRecords({ ...options, savedOnly: true, query: '动名词' });
    assert.equal(view.records.length, 1);
    assert.equal(view.counts.all, 1);
    assert.equal(view.counts.notes, 1);
    assert.equal(view.counts.ai, 0);
    assert.equal(selectReadingRecords({ ...options, filter: 'ai', savedOnly: true }).records.length, 0);
});

test('搜尋涵蓋文件正文、個人筆記及儲存的解釋', () => {
    assert.deepEqual(selectReadingRecords({ ...options, query: 'usage' }).records.map(record => record.entity.id), ['ai']);
    assert.equal(selectReadingRecords({ ...options, query: '请求' }).records.length, 2);
    const view = selectReadingRecords({ items: [{ id: 'meaning', explanation: { result: { translation: '附件' } } }], query: '附件' });
    assert.equal(view.records.length, 1);
});

test('最近查閱與最近更新排序，未知錨點不搶在可定位項前面', () => {
    assert.equal(selectReadingRecords({ ...options, filter: 'words', sort: 'viewed' }).records[0].entity.id, 'phrase');
    assert.deepEqual(selectReadingRecords({ ...options, sort: 'viewed' }).records.slice(0, 2).map(record => record.entity.id), ['sentence', 'phrase']);
    assert.equal(selectReadingRecords({ ...options, sort: 'updated' }).records[0].entity.id, 'ai');
    assert.deepEqual(selectReadingRecords({ ...options, filter: 'words' }).records.map(record => record.entity.id), ['phrase', 'unknown']);
});
