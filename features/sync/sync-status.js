// 同步階段完成後的介面回饋（純函式、沒有 DOM／儲存依賴，方便單元測試）。
//
// 手動與自動同步都要走同一套判斷：文章階段回 `{ ok:false }`（`syncArticles()`
// 以 `ok:false` 回報失敗、並不拋出）時必須顯示文章同步失敗，**不得**再顯示
// 「同步完成」。單篇推送失敗／衝突（`pushed.failed`／`pushed.conflicts`）也
// 不算完成，只能顯示「文章同步未完成」。把判斷抽出來，才能用 node 測試覆蓋
// 「失敗／未完成都不顯示完成」這條規則。
//
// 回傳 `{ statusKey, toastKey, toastLevel, toastMs }`：
//   statusKey：狀態列文字（必要）
//   toastKey ：額外提示（空字串＝不彈提示）
export function resolveSyncCompletion(options = {}) {
    const manual = options.manual === true;
    const restoredFromRemote = options.restoredFromRemote === true;
    // 只有「明確是 true」才算成功：undefined／false（或包裝層回報失敗）都算失敗。
    const articleOk = options.articleOk === true;
    const articlePending = options.articlePending === true;
    const readingUnsupported = options.readingUnsupported === true;

    if (restoredFromRemote) {
        if (!articleOk) {
            // 還原與文章失敗同時發生：不能只用還原提示蓋掉文章失敗。
            return manual
                ? {
                    statusKey: 'sync.restoredArticleSyncFailed',
                    toastKey: 'sync.restoredArticleSyncFailed',
                    toastLevel: 'error'
                }
                : { statusKey: 'sync.restoredArticleSyncFailed', toastKey: '', toastLevel: '' };
        }
        if (articlePending) {
            // 還原成功但有單篇失敗／衝突：還原提示同樣不能蓋掉「未完成」。
            // 手動同步給 warning 提示，自動同步只更新狀態列。
            return manual
                ? {
                    statusKey: 'sync.restoredArticleSyncPending',
                    toastKey: 'sync.restoredArticleSyncPending',
                    toastLevel: 'warning',
                    toastMs: 5000
                }
                : { statusKey: 'sync.restoredArticleSyncPending', toastKey: '', toastLevel: '' };
        }
        // 從雲端還原的提示優先於階段結果（沒有文章失敗時）：使用者的本機資料
        // 狀況比階段結果更重要。
        return manual
            ? { statusKey: 'sync.restoredEmpty', toastKey: 'sync.restoredEmptyMessage', toastLevel: 'warning', toastMs: 5000 }
            : { statusKey: 'sync.restoredAutomatic', toastKey: 'sync.restoredAutomatic', toastLevel: 'warning', toastMs: 5000 };
    }
    if (!articleOk) {
        return manual
            ? { statusKey: 'sync.articleSyncFailed', toastKey: 'sync.articleSyncFailed', toastLevel: 'error' }
            : { statusKey: 'sync.articleSyncFailed', toastKey: '', toastLevel: '' };
    }
    if (articlePending) {
        // 單篇推送失敗／衝突：這一輪沒有全部完成，不得顯示 syncDone。
        // 手動同步可提示使用者稍後重試；自動同步只更新狀態列，避免干擾。
        return manual
            ? {
                statusKey: 'sync.articleSyncPending',
                toastKey: 'sync.articleSyncPending',
                toastLevel: 'warning',
                toastMs: 5000
            }
            : { statusKey: 'sync.articleSyncPending', toastKey: '', toastLevel: '' };
    }
    if (readingUnsupported) {
        return { statusKey: 'sync.readingServerUpdateRequired', toastKey: '', toastLevel: '' };
    }
    return manual
        ? { statusKey: 'sync.syncDone', toastKey: 'sync.syncDone', toastLevel: 'success', toastMs: 2000 }
        : { statusKey: 'sync.syncDone', toastKey: '', toastLevel: '' };
}
