// <details> 展開狀態保存。
//
// AI 供應商設定與管理員面板每次互動都會整塊重建 DOM（innerHTML）。若不在重建前
// 記住 open 狀態，使用者一選模型，正在看的「按功能指定模型」或「進階設定」就會
// 立刻折疊回去，看起來像視窗自己關起來。需要保留狀態的 <details> 加上
// data-keep-open="<唯一鍵>" 即可。

export function captureDetailState(root) {
    const state = new Map();
    if (!root || typeof root.querySelectorAll !== 'function') return state;
    for (const details of root.querySelectorAll('details[data-keep-open]')) {
        state.set(details.dataset.keepOpen, details.open);
    }
    return state;
}

export function restoreDetailState(root, state) {
    if (!root || !state || !state.size) return;
    for (const details of root.querySelectorAll('details[data-keep-open]')) {
        const open = state.get(details.dataset.keepOpen);
        if (typeof open === 'boolean' && details.open !== open) details.open = open;
    }
}
