// 文章同步用的最小 mock Worker。
//
// 只實作 article-sync.js 實際會打的路徑（游標拉取、批次取文件、建立、更新、
// 舊資料匯入），並提供可注入的 hook，讓測試能「先讓伺服器提交、再暫扣回應」。
//
// 時間戳刻意用嚴格遞增的合成時間（而不是 Date.now()）：同一毫秒內完成的
// 兩次寫入若拿到相同 updatedAt，「舊回執不得改動 updatedAt」的斷言就會失去
// 鑑別力。
//
// 這個 helper 只用於測試，不進前端執行路徑。

export function createArticleSyncServer(options = {}) {
    const epoch = Date.UTC(2026, 0, 1, 0, 0, 0);
    const state = {
        articles: new Map(),
        seq: 0,
        importCalls: 0,
        importPayloads: [],
        batchCalls: 0,
        createCalls: 0,
        putCalls: 0,
        deleteCalls: 0,
        restoreCalls: 0,
        finalCalls: 0,
        failWrites: false,
        // 伺服器要求完整重拉（delta 回應 resetRequired）的模擬開關。
        resetRequired: false,
        hooks: {}
    };

    function stamp() {
        state.seq += 1;
        return new Date(epoch + state.seq * 1000).toISOString();
    }

    function json(body, status = 200) {
        return new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const fetch = async (url, init = {}) => {
        const path = new URL(url).pathname;
        const method = init.method || 'GET';
        const body = init.body ? JSON.parse(init.body) : null;

        if (path === '/articles/import' && method === 'POST') {
            state.importCalls += 1;
            const items = Array.isArray(body?.articles) ? body.articles : [];
            if (items.length) state.importPayloads.push(items.map((item) => item.legacyId));
            await state.hooks.beforeImport?.({ body });
            const ids = [];
            let skipped = 0;
            for (const item of items) {
                const id = String(item.legacyId || item.id || '');
                if (state.articles.has(id)) { skipped += 1; continue; }
                state.articles.set(id, {
                    id,
                    title: item.title || '',
                    body: item.body || '',
                    analysis: item.analysis ?? null,
                    sourceType: item.sourceType || 'paste',
                    sourceUrl: item.sourceUrl || '',
                    revision: 1,
                    updatedAt: stamp(),
                    lastMutationId: '',
                    deletedAt: ''
                });
                ids.push(id);
            }
            if (body?.final === true) state.finalCalls += 1;
            await state.hooks.afterImport?.({ body, ids });
            return json({
                imported: ids.length,
                skipped,
                invalid: 0,
                ids,
                cursor: state.seq,
                legacyWriteBlocked: body?.final === true || state.finalCalls > 0
            });
        }

        if (path === '/articles/batch' && method === 'POST') {
            state.batchCalls += 1;
            const ids = Array.isArray(body?.ids) ? body.ids : [];
            // 查詢結果在請求當下就決定；hook 只延後回應送達。
            const articles = ids.map((id) => state.articles.get(id)).filter((doc) => doc && !doc.deletedAt);
            await state.hooks.batch?.({ ids, call: state.batchCalls, articles });
            return json({ articles });
        }

        if (path === '/articles' && method === 'GET') {
            const parsed = new URL(url);
            const full = parsed.searchParams.get('full') === '1';
            // 測試可在這裡暫扣拉取回應，重現「分頁停在 pull 等待」的競態。
            await state.hooks.beforePull?.({ full, url: parsed });
            if (full) {
                const all = Array.from(state.articles.values());
                const offset = Number(parsed.searchParams.get('offset')) || 0;
                const limit = Number(parsed.searchParams.get('limit')) || 500;
                const page = all.slice(offset, offset + limit);
                return json({
                    articles: page,
                    cursor: state.seq,
                    hasMore: offset + page.length < all.length,
                    offset: offset + page.length
                });
            }
            if (state.resetRequired) {
                return json({ resetRequired: true, cursor: state.seq, serverCursor: state.seq, changes: [] });
            }
            return json({
                resetRequired: false,
                cursor: state.seq,
                serverCursor: state.seq,
                changes: [],
                hasMore: false
            });
        }

        if (path === '/articles' && method === 'POST') {
            state.createCalls += 1;
            if (state.failWrites) return json({ code: 'temporary_failure' }, 503);
            const id = String(body?.id || '');
            if (state.articles.has(id)) return json({ code: 'article_id_exists' }, 409);
            state.articles.set(id, {
                id,
                title: body.title || '',
                body: body.body || '',
                analysis: body.analysis ?? null,
                sourceType: body.sourceType || 'paste',
                sourceUrl: body.sourceUrl || '',
                revision: 1,
                updatedAt: stamp(),
                lastMutationId: body?.clientMutationId || '',
                deletedAt: ''
            });
            return json({ article: state.articles.get(id) }, 201);
        }

        const restoreMatch = path.match(/^\/articles\/([^/]+)\/restore$/);
        if (restoreMatch && method === 'POST') {
            state.restoreCalls += 1;
            if (state.failWrites) return json({ code: 'temporary_failure' }, 503);
            const id = decodeURIComponent(restoreMatch[1]);
            const existing = state.articles.get(id);
            if (!existing) return json({ code: 'article_not_found' }, 404);
            // 與 Worker 一致：同一個 mutation ID 的重試是冪等的。
            if (body?.clientMutationId && existing.lastMutationId === body.clientMutationId) {
                return json({ article: existing, restored: true, idempotent: true });
            }
            if (!existing.deletedAt) {
                // Worker：已不是墓碑時，版本相同算冪等成功，否則回 not_deleted。
                if (Number(body?.expectedRevision) === Number(existing.revision)) {
                    return json({ article: existing, restored: true, idempotent: true });
                }
                return json({ code: 'article_not_deleted', current: existing }, 409);
            }
            if (Number(body?.expectedRevision) !== Number(existing.revision)) {
                return json({ code: 'article_revision_conflict', current: existing }, 409);
            }
            const next = {
                ...existing,
                deletedAt: '',
                revision: existing.revision + 1,
                updatedAt: stamp(),
                lastMutationId: body?.clientMutationId || existing.lastMutationId || ''
            };
            state.articles.set(id, next);
            // 提交已完成、回應才暫扣：用來重現「restore 回應遲到、期間別的分頁
            // 已完成 restore + PUT 並清掉 outbox」。
            await state.hooks.afterRestore?.({ id, body, article: next });
            return json({ article: next, restored: true });
        }

        const single = path.match(/^\/articles\/([^/]+)$/);
        if (single) {
            const id = decodeURIComponent(single[1]);
            if (state.failWrites) return json({ code: 'temporary_failure' }, 503);
            const existing = state.articles.get(id);
            if (!existing) return json({ code: 'article_not_found' }, 404);
            if (method === 'PUT') {
                state.putCalls += 1;
                // 測試可注入失敗回應（例如 restore 已成功、PUT 回 503）。
                const injected = await state.hooks.beforePut?.({ id, body });
                if (injected) return injected;
                // 與 Worker 一致：同一個 mutation ID 的重試是冪等的（回應遺失後
                // 重送不會再改版本），這是「舊回執在重建後才回來」的前提。
                if (body?.clientMutationId && existing.lastMutationId === body.clientMutationId) {
                    return json({ article: existing, updated: false, idempotent: true });
                }
                // 與 Worker 一致：墓碑不允許 PUT，必須先 restore。
                if (existing.deletedAt) {
                    return json({ code: 'article_already_deleted', current: existing }, 409);
                }
                if (Number(body?.expectedRevision) !== Number(existing.revision)) {
                    return json({ code: 'article_revision_conflict', current: existing }, 409);
                }
                const next = {
                    ...existing,
                    title: body.title ?? existing.title,
                    body: body.body ?? existing.body,
                    analysis: body.analysis ?? existing.analysis,
                    revision: existing.revision + 1,
                    updatedAt: stamp(),
                    lastMutationId: body?.clientMutationId || existing.lastMutationId || ''
                };
                state.articles.set(id, next);
                // 提交已完成、回應才暫扣：用來重現「重建前送出的 PUT 回執遲到」。
                await state.hooks.afterPut?.({ id, body, article: next });
                return json({ article: next });
            }
            if (method === 'DELETE') {
                state.deleteCalls += 1;
                if (Number(body?.expectedRevision) !== Number(existing.revision)) {
                    return json({ code: 'article_revision_conflict', current: existing }, 409);
                }
                const next = { ...existing, revision: existing.revision + 1, updatedAt: stamp(), deletedAt: stamp() };
                state.articles.set(id, next);
                return json({ article: next });
            }
        }

        return json({ code: 'not_found' }, 404);
    };

    return { state, fetch };
}
