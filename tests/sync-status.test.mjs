// 第十三輪缺口 3（R3）：文章同步階段失敗不得被介面吞掉。
//
// `syncArticles()` 以 `{ ok:false, error }` 回報失敗（不拋出），所以
// `runArticleSyncPhase()` 必須把 `ok:false` 轉成 `{ ok:false, error }`，手動與
// 自動同步都不得再顯示「同步完成」。
//
// 這裡覆蓋兩層：
//   1. `features/sync/sync-status.js`：完成狀態的純函式判斷（可完整列舉）。
//   2. `features/sync/sync.js` 的接線：包裝層把 `info.ok === false` 視為失敗，
//      且兩條路徑都以 `articlePhase.ok === true` 交給上面那個判斷。
//
// Usage: node --test tests/sync-status.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveSyncCompletion } from '../features/sync/sync-status.js';
import zhCN from '../locales/zh-CN.js';
import zhHK from '../locales/zh-HK.js';

const SYNC_JS = new URL('../features/sync/sync.js', import.meta.url);

function pick(dict, key) {
    return key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), dict);
}

test('手動同步：文章階段失敗顯示 articleSyncFailed，不顯示 syncDone', () => {
    const completion = resolveSyncCompletion({
        manual: true,
        restoredFromRemote: false,
        articleOk: false,
        readingUnsupported: false
    });
    assert.equal(completion.statusKey, 'sync.articleSyncFailed');
    assert.notEqual(completion.statusKey, 'sync.syncDone');
    assert.notEqual(completion.toastKey, 'sync.syncDone');
    assert.equal(completion.toastKey, 'sync.articleSyncFailed');
    assert.equal(completion.toastLevel, 'error');
});

test('自動同步：文章階段失敗顯示 articleSyncFailed，不顯示 syncDone 也不彈成功提示', () => {
    const completion = resolveSyncCompletion({
        manual: false,
        restoredFromRemote: false,
        articleOk: false,
        readingUnsupported: false
    });
    assert.equal(completion.statusKey, 'sync.articleSyncFailed');
    assert.notEqual(completion.statusKey, 'sync.syncDone');
    assert.equal(completion.toastKey, '');
});

test('沒有明確的成功旗標（undefined）一律當成失敗，不會誤顯示完成', () => {
    for (const manual of [true, false]) {
        const completion = resolveSyncCompletion({ manual });
        assert.equal(completion.statusKey, 'sync.articleSyncFailed', JSON.stringify(completion));
    }
});

test('文章階段成功時才顯示 syncDone（手動附成功提示、自動不彈提示）', () => {
    const manual = resolveSyncCompletion({
        manual: true,
        restoredFromRemote: false,
        articleOk: true,
        readingUnsupported: false
    });
    assert.equal(manual.statusKey, 'sync.syncDone');
    assert.equal(manual.toastKey, 'sync.syncDone');
    assert.equal(manual.toastLevel, 'success');

    const auto = resolveSyncCompletion({
        manual: false,
        restoredFromRemote: false,
        articleOk: true,
        readingUnsupported: false
    });
    assert.equal(auto.statusKey, 'sync.syncDone');
    assert.equal(auto.toastKey, '');
});

test('閱讀後端未支援與雲端還原的顯示優先順序維持不變', () => {
    const unsupported = resolveSyncCompletion({
        manual: true,
        restoredFromRemote: false,
        articleOk: true,
        articlePending: false,
        readingUnsupported: true
    });
    assert.equal(unsupported.statusKey, 'sync.readingServerUpdateRequired');

    // 文章階段失敗的優先度高於閱讀未支援：只要文章失敗就不會顯示 syncDone。
    const both = resolveSyncCompletion({
        manual: true,
        restoredFromRemote: false,
        articleOk: false,
        readingUnsupported: true
    });
    assert.equal(both.statusKey, 'sync.articleSyncFailed');

    // 文章未完成（部分失敗）的優先度也高於閱讀未支援，但低於文章失敗。
    const pendingOverUnsupported = resolveSyncCompletion({
        manual: true,
        restoredFromRemote: false,
        articleOk: true,
        articlePending: true,
        readingUnsupported: true
    });
    assert.equal(pendingOverUnsupported.statusKey, 'sync.articleSyncPending');

    // 第十四輪（F）：還原與文章失敗同時發生時改為組合訊息，不再讓還原提示
    // 單獨遮蔽文章失敗。
    const restoredManual = resolveSyncCompletion({ manual: true, restoredFromRemote: true, articleOk: false });
    assert.equal(restoredManual.statusKey, 'sync.restoredArticleSyncFailed');
    const restoredAuto = resolveSyncCompletion({ manual: false, restoredFromRemote: true, articleOk: true });
    assert.equal(restoredAuto.statusKey, 'sync.restoredAutomatic');
});

test('單篇推送失敗／衝突（articlePending）：手動顯示 warning 提示、自動只更新狀態列，都不顯示 syncDone', () => {
    for (const [countKey, count] of [['failed', 1], ['conflicts', 1]]) {
        const manual = resolveSyncCompletion({
            manual: true,
            restoredFromRemote: false,
            articleOk: true,
            articlePending: true,
            readingUnsupported: false
        });
        assert.equal(manual.statusKey, 'sync.articleSyncPending', countKey);
        assert.notEqual(manual.statusKey, 'sync.syncDone');
        assert.equal(manual.toastKey, 'sync.articleSyncPending', countKey);
        assert.equal(manual.toastLevel, 'warning', countKey);

        const auto = resolveSyncCompletion({
            manual: false,
            restoredFromRemote: false,
            articleOk: true,
            articlePending: true,
            readingUnsupported: false
        });
        assert.equal(auto.statusKey, 'sync.articleSyncPending', countKey);
        assert.notEqual(auto.statusKey, 'sync.syncDone');
        assert.equal(auto.toastKey, '', countKey);
    }
});

test('雲端還原與文章失敗同時發生：顯示組合訊息，手動與自動都不得只顯示還原成功', () => {
    const manual = resolveSyncCompletion({
        manual: true,
        restoredFromRemote: true,
        articleOk: false,
        articlePending: false
    });
    assert.equal(manual.statusKey, 'sync.restoredArticleSyncFailed');
    assert.notEqual(manual.statusKey, 'sync.restoredEmpty');
    assert.notEqual(manual.statusKey, 'sync.articleSyncFailed');
    assert.equal(manual.toastKey, 'sync.restoredArticleSyncFailed');
    assert.equal(manual.toastLevel, 'error');

    const auto = resolveSyncCompletion({
        manual: false,
        restoredFromRemote: true,
        articleOk: false,
        articlePending: false
    });
    assert.equal(auto.statusKey, 'sync.restoredArticleSyncFailed');
    assert.equal(auto.toastKey, '');

    // 只有還原：維持原本還原提示。
    const restoredOnly = resolveSyncCompletion({ manual: true, restoredFromRemote: true, articleOk: true });
    assert.equal(restoredOnly.statusKey, 'sync.restoredEmpty');
    // 只有文章失敗：維持失敗提示。
    const articleFailedOnly = resolveSyncCompletion({ manual: true, restoredFromRemote: false, articleOk: false });
    assert.equal(articleFailedOnly.statusKey, 'sync.articleSyncFailed');
});

test('雲端還原與文章未完成同時發生：顯示組合訊息，不得只顯示還原成功或 syncDone', () => {
    const manual = resolveSyncCompletion({
        manual: true,
        restoredFromRemote: true,
        articleOk: true,
        articlePending: true
    });
    assert.equal(manual.statusKey, 'sync.restoredArticleSyncPending');
    assert.equal(manual.toastKey, 'sync.restoredArticleSyncPending', '手動同步必須提示文章未完成');
    assert.equal(manual.toastLevel, 'warning');
    assert.notEqual(manual.statusKey, 'sync.syncDone');
    assert.notEqual(manual.statusKey, 'sync.restoredEmpty');
    assert.notEqual(manual.statusKey, 'sync.restoredAutomatic');
    assert.notEqual(manual.statusKey, 'sync.articleSyncPending');

    const auto = resolveSyncCompletion({
        manual: false,
        restoredFromRemote: true,
        articleOk: true,
        articlePending: true
    });
    assert.equal(auto.statusKey, 'sync.restoredArticleSyncPending');
    assert.equal(auto.toastKey, '', '自動同步只更新狀態列');
    assert.notEqual(auto.statusKey, 'sync.syncDone');
    assert.notEqual(auto.statusKey, 'sync.restoredAutomatic');

    // 只有還原（沒有未完成）仍是純還原提示，不能被新分支搶先。
    const restoredOnly = resolveSyncCompletion({
        manual: true,
        restoredFromRemote: true,
        articleOk: true,
        articlePending: false
    });
    assert.equal(restoredOnly.statusKey, 'sync.restoredEmpty');
});

test('所有可能回傳的鍵都有 zh-CN 與 zh-HK 文案', () => {
    const keys = new Set();
    for (const manual of [true, false]) {
        for (const restoredFromRemote of [true, false]) {
            for (const articleOk of [true, false]) {
                for (const articlePending of [true, false]) {
                    for (const readingUnsupported of [true, false]) {
                        const completion = resolveSyncCompletion({
                            manual,
                            restoredFromRemote,
                            articleOk,
                            articlePending,
                            readingUnsupported
                        });
                        keys.add(completion.statusKey);
                        if (completion.toastKey) keys.add(completion.toastKey);
                    }
                }
            }
        }
    }
    assert.ok(keys.size >= 6, `列舉到的鍵太少：${[...keys].join(',')}`);
    for (const key of keys) {
        for (const [name, dict] of [['zh-CN', zhCN], ['zh-HK', zhHK]]) {
            const value = pick(dict, key);
            assert.equal(typeof value, 'string', `${name} 缺少 ${key}`);
            assert.ok(value.trim().length > 0, `${name} 的 ${key} 是空字串`);
        }
    }
});

test('sync.js 的包裝層把 syncArticles() 的 ok:false 轉成失敗，且兩條路徑都依 articlePhase.ok 顯示', async () => {
    const source = await readFile(SYNC_JS, 'utf8');

    // 1) runArticleSyncPhase 必須辨識 `info.ok === false`（syncArticles 不拋出）。
    const phaseStart = source.indexOf('async function runArticleSyncPhase()');
    assert.ok(phaseStart > 0, '找不到 runArticleSyncPhase');
    const phaseBody = source.slice(phaseStart, source.indexOf('/**', phaseStart + 10));
    assert.match(phaseBody, /info\.ok === false/, 'runArticleSyncPhase 沒有處理 info.ok === false');
    assert.match(phaseBody, /return \{ ok: false, error: .*article_sync_failed/, '失敗結果沒有帶回錯誤碼');
    assert.match(phaseBody, /stale_session/, 'stale_session 必須維持拋出行為');

    // 2) 手動與自動同步都以 articlePhase.ok === true 作為成功條件，並把
    //    pending（單篇失敗／衝突）交給完成狀態判斷。
    const passCount = (source.match(/articleOk: articlePhase\.ok === true/g) || []).length;
    assert.equal(passCount, 2, '手動與自動同步都必須把 articlePhase.ok 交給完成狀態判斷');
    const pendingCount = (source.match(/articlePending: articlePhase\.pending === true/g) || []).length;
    assert.equal(pendingCount, 2, '手動與自動同步都必須把 articlePhase.pending 交給完成狀態判斷');
    assert.match(source, /const pending = failed > 0 \|\| conflicts > 0/, 'runArticleSyncPhase 必須回報單篇失敗／衝突為 pending');

    // 3) 「同步完成」只能經由 completion 顯示，不得再有寫死的分支。
    assert.equal((source.match(/t\('sync\.syncDone'\)/g) || []).length, 0, 'sync.js 仍有寫死的 syncDone');
    assert.equal(
        (source.match(/resolveSyncCompletion\(/g) || []).length,
        2,
        '手動與自動同步應各呼叫一次 resolveSyncCompletion'
    );
});
