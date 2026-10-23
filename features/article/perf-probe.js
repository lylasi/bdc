/**
 * 文章長文效能量測探針（P3-T5：只量測，不優化）。
 *
 * 設計邊界（刻意很小）：
 *   - 只在 URL `?perf=1` 或 `localStorage['bdc:perf'] === '1'` 時啟用。
 *     關閉時：不安裝 `PerformanceObserver`、不建立 `window.__bdcPerf`、
 *     不新增任何 DOM／listener，所有 export 都是 no-op。
 *   - 不改變產品行為：不改 debounce、concurrency、請求數或渲染路徑；
 *     呼叫端只在既有流程的節點上多呼叫一個函式。
 *   - 只記錄「長度、數量、耗時」：不保存文章原文、句子、詞或助手內容，
 *     不下載以外的任何傳輸（沒有上傳）。
 *
 * 對外 API（呼叫端只需要這幾個）：
 *   markAnalysisStart()                        analyzeArticle 開始
 *   markAnalysisDone(meta)                     所有段落 render 完成
 *   markAnalysisSettled(status)                取消／失敗／無效輸入的收尾
 *   recordArticleStats({ characters, paragraphs })
 *   beginWordTooltip() / markWordTooltip()     點詞 → tooltip 可見
 *   beginReadingChunks() / markReadingChunks()  buildReadingChunks 耗時
 *   recordAssistantTurn({ contextChars, messageChars, messageCount })
 *   markAssistantRequest()                     助手實際送出的請求數
 *   snapshot() / download() / reset() / isEnabled()
 */

const STORAGE_KEY = 'bdc:perf';
const QUERY_KEY = 'perf';
const MAX_SAMPLES = 500;

const hasWindow = typeof window !== 'undefined';

function readEnabled() {
    if (!hasWindow) return false;
    try {
        if (new URLSearchParams(window.location.search).get(QUERY_KEY) === '1') return true;
    } catch (_) { /* noop */ }
    try {
        return window.localStorage.getItem(STORAGE_KEY) === '1';
    } catch (_) {
        return false;
    }
}

export const ENABLED = readEnabled();

const LIMITATIONS = [
    '只量測前端成本（DOM、分詞包字、tooltip 顯示、context 組裝），不代表供應商網路或模型延遲。',
    '測試使用 route mock 固定回應；mock 延遲與真實供應商差異很大，數字不可用來推論線上等待時間。',
    'long task 由瀏覽器 Long Tasks API 提供，Safari／Firefox 支援不一致；不支援時標示 unavailable，不當成 0。',
    '單一機器、單一瀏覽器、單一視窗大小的結果；不可宣稱代表所有裝置或所有長文。',
    '點詞延遲量的是「點擊到 tooltip 外殼可見」（含下一個動畫框），不是 AI 回應時間。',
    'analyze 量測含既有 400ms 段落間隔與併發上限（產品現行行為），不是純渲染時間。'
];

/** @returns {number} 四捨五入到 0.01ms，避免報告出現無意義長尾。 */
function roundMs(value) {
    return Math.round(Number(value || 0) * 100) / 100;
}

function percentiles(samples) {
    if (!samples.length) return { count: 0, p50: null, p95: null, min: null, max: null };
    const sorted = [...samples].sort((a, b) => a - b);
    const at = (p) => {
        const rank = (sorted.length - 1) * p;
        const lower = Math.floor(rank);
        const upper = Math.min(sorted.length - 1, lower + 1);
        const frac = rank - lower;
        return roundMs(sorted[lower] + (sorted[upper] - sorted[lower]) * frac);
    };
    return {
        count: samples.length,
        p50: at(0.5),
        p95: at(0.95),
        min: roundMs(sorted[0]),
        max: roundMs(sorted[sorted.length - 1])
    };
}

const state = {
    article: { characters: null, paragraphs: null },
    analyze: null,
    analysisSeq: 0,
    wordSamples: [],
    readingChunks: [],
    assistantTurns: [],
    activeTurn: null
};

const longtask = {
    supported: false,
    unavailable: 'disabled',
    count: 0,
    totalMs: 0,
    maxMs: 0,
    countOver200: 0,
    totalOver200Ms: 0,
    // 只留時間與時長，不含任何內容；用來把長 task 對到互動階段。
    entries: [],
    observer: null
};

function countDomNodes() {
    try { return document.querySelectorAll('*').length; } catch (_) { return null; }
}

function countInteractiveWords() {
    try { return document.querySelectorAll('.interactive-word').length; } catch (_) { return null; }
}

function mark(name) {
    try { performance.mark(name); } catch (_) { /* noop */ }
}

function measure(name, startMark, endMark) {
    try { performance.measure(name, startMark, endMark); } catch (_) { /* noop */ }
}

function now() {
    try { return performance.now(); } catch (_) { return Date.now(); }
}

function longtaskBaseline() {
    return {
        count: longtask.count,
        totalMs: longtask.totalMs,
        countOver200: longtask.countOver200
    };
}

function installLongTaskObserver() {
    if (!hasWindow || typeof PerformanceObserver !== 'function') {
        longtask.unavailable = 'PerformanceObserver-unavailable';
        return;
    }
    const supportedTypes = PerformanceObserver.supportedEntryTypes;
    if (Array.isArray(supportedTypes) && !supportedTypes.includes('longtask')) {
        longtask.unavailable = 'longtask-entry-unsupported';
        return;
    }
    try {
        const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                const duration = Number(entry.duration) || 0;
                longtask.count += 1;
                longtask.totalMs += duration;
                if (duration > longtask.maxMs) longtask.maxMs = duration;
                if (duration >= 200) {
                    longtask.countOver200 += 1;
                    longtask.totalOver200Ms += duration;
                }
                longtask.entries.push({
                    startTime: roundMs(entry.startTime),
                    duration: roundMs(duration)
                });
                if (longtask.entries.length > 100) longtask.entries.shift();
            }
        });
        observer.observe({ type: 'longtask', buffered: true });
        longtask.observer = observer;
        longtask.supported = true;
        longtask.unavailable = null;
    } catch (error) {
        longtask.unavailable = `observe-failed:${error && error.message ? error.message : 'unknown'}`;
    }
}

if (ENABLED) {
    installLongTaskObserver();
    try {
        window.__bdcPerf = {
            enabled: true,
            snapshot,
            download,
            reset,
            // 輪詢用：不需要建立完整 snapshot，避免量測本身製造 long task。
            analysisStatus: () => (state.analyze ? state.analyze.status : 'idle'),
            // 階段邊界用：只回長 task 統計，不掃 DOM。
            longtaskStats: () => ({
                supported: longtask.supported,
                unavailable: longtask.unavailable,
                count: longtask.count,
                totalMs: roundMs(longtask.totalMs),
                maxMs: roundMs(longtask.maxMs),
                countOver200: longtask.countOver200,
                totalOver200Ms: roundMs(longtask.totalOver200Ms)
            }),
            isEnabled: () => true
        };
    } catch (_) { /* noop */ }
    mark('bdc:perf:enabled');
}

/** probe 是否啟用；呼叫端不需要自行判斷。 */
export function isEnabled() {
    return ENABLED;
}

/** analyzeArticle 解析出段落後記錄規模（只記長度）。 */
export function recordArticleStats({ characters = null, paragraphs = null } = {}) {
    if (!ENABLED) return;
    if (Number.isFinite(characters)) state.article.characters = characters;
    if (Number.isFinite(paragraphs)) state.article.paragraphs = paragraphs;
}

export function markAnalysisStart() {
    if (!ENABLED) return null;
    mark('bdc:analysis:start');
    const id = ++state.analysisSeq;
    state.analyze = {
        id,
        startedAt: new Date().toISOString(),
        start: now(),
        characters: state.article.characters,
        paragraphs: state.article.paragraphs,
        longtaskBase: longtaskBaseline(),
        status: 'running'
    };
    return id;
}

function finishAnalysis(status) {
    const current = state.analyze;
    if (!current) return null;
    const end = now();
    mark('bdc:analysis:end');
    measure('bdc:analysis', 'bdc:analysis:start', 'bdc:analysis:end');
    current.status = status;
    current.totalMs = roundMs(end - current.start);
    current.domNodes = countDomNodes();
    current.interactiveWords = countInteractiveWords();
    current.longTasks = {
        count: longtask.count - current.longtaskBase.count,
        countOver200: longtask.countOver200 - current.longtaskBase.countOver200,
        totalMs: roundMs(longtask.totalMs - current.longtaskBase.totalMs)
    };
    delete current.start;
    delete current.longtaskBase;
    return current;
}

/** 全部段落完成 render（不是等最後一次 IndexedDB 保存）。 */
export function markAnalysisDone(token, meta = {}) {
    if (!ENABLED || !state.analyze) return;
    // 同一頁可能有前一個已取消的回合較晚收尾；token 不符不得蓋掉新回合。
    if (token != null && state.analyze.id !== token) return;
    finishAnalysis(meta.status || 'rendered');
}

/** 取消／失敗／無效輸入：把已開始但沒有 render 完成的回合收尾。 */
export function markAnalysisSettled(token, status = 'cancelled') {
    if (!ENABLED || !state.analyze) return;
    if (token != null && state.analyze.id !== token) return;
    if (state.analyze.status !== 'running') return;
    finishAnalysis(status);
}

/** 點詞開始（showArticleWordAnalysis 入口）。 */
export function beginWordTooltip() {
    if (!ENABLED) return;
    state.pendingWord = { start: now() };
    mark('bdc:word:start');
}

/** tooltip 外殼可見（renderTooltipShell 第一次設 display:block 之後）。 */
export function markWordTooltip() {
    if (!ENABLED || !state.pendingWord) return;
    const pending = state.pendingWord;
    state.pendingWord = null;
    const finish = () => {
        const duration = now() - pending.start;
        mark('bdc:word:visible');
        measure('bdc:word', 'bdc:word:start', 'bdc:word:visible');
        state.wordSamples.push(roundMs(duration));
        if (state.wordSamples.length > MAX_SAMPLES) state.wordSamples.shift();
    };
    // 「可見」包含下一個動畫框；長 task 造成的延遲也應該被算進來。
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(finish);
    else finish();
}

/** buildReadingChunks 入口：回傳起始時間；關閉時回 0。 */
export function beginReadingChunks() {
    return ENABLED ? now() : 0;
}

/** buildReadingChunks 結束：只記段數與字元總數，不記內容。 */
export function markReadingChunks(startedAt, chunks) {
    if (!ENABLED || !startedAt) return;
    const list = Array.isArray(chunks) ? chunks : [];
    const characters = list.reduce((sum, chunk) => sum + String(chunk?.text || '').length, 0);
    state.readingChunks.push({
        ms: roundMs(now() - startedAt),
        chunks: list.length,
        characters
    });
    if (state.readingChunks.length > MAX_SAMPLES) state.readingChunks.shift();
}

/**
 * 助手每輪開始：記錄 context／messages 長度。
 * 實際請求數由 markAssistantRequest() 在真正送出時累加。
 */
export function recordAssistantTurn({ contextChars = null, messageChars = null, messageCount = null } = {}) {
    if (!ENABLED) return;
    const turn = {
        at: new Date().toISOString(),
        contextCharacters: Number.isFinite(contextChars) ? contextChars : null,
        messageCharacters: Number.isFinite(messageChars) ? messageChars : null,
        messageCount: Number.isFinite(messageCount) ? messageCount : null,
        requestCount: 0,
        unavailable: []
    };
    if (!Number.isFinite(contextChars)) turn.unavailable.push('contextCharacters');
    if (!Number.isFinite(messageCount)) turn.unavailable.push('messageCount');
    state.assistantTurns.push(turn);
    if (state.assistantTurns.length > 50) state.assistantTurns.shift();
    state.activeTurn = turn;
}

/** 助手實際發出一次 provider 請求（串流或非串流）。 */
export function markAssistantRequest() {
    if (!ENABLED) return;
    if (!state.activeTurn) return;
    state.activeTurn.requestCount += 1;
}

function summarizeReadingChunks() {
    const samples = state.readingChunks;
    const values = samples.map((item) => item.ms);
    const summary = percentiles(values);
    const last = samples[samples.length - 1] || null;
    return {
        calls: samples.length,
        ...summary,
        last,
        samples: samples.slice(-50)
    };
}

/** 回傳可 JSON 化的量測快照（不含任何文章／詞／助手內容）。 */
export function snapshot() {
    if (!ENABLED) return null;
    const measures = [];
    try {
        for (const entry of performance.getEntriesByType('measure')) {
            if (!String(entry.name || '').startsWith('bdc:')) continue;
            measures.push({ name: entry.name, duration: roundMs(entry.duration) });
        }
    } catch (_) { /* noop */ }
    const word = percentiles(state.wordSamples);
    let locale = '';
    try { locale = document.documentElement.lang || ''; } catch (_) { /* noop */ }
    return {
        schemaVersion: 1,
        probeEnabled: true,
        generatedAt: new Date().toISOString(),
        environment: {
            userAgent: (hasWindow && navigator.userAgent) || '',
            viewport: (hasWindow && window.innerWidth) ? {
                width: window.innerWidth,
                height: window.innerHeight,
                devicePixelRatio: Number(window.devicePixelRatio) || 1
            } : null,
            locale,
            hardwareConcurrency: (hasWindow && Number(navigator.hardwareConcurrency)) || null,
            deviceMemory: (hasWindow && Number(navigator.deviceMemory)) || null
        },
        article: {
            characters: state.article.characters,
            paragraphs: state.article.paragraphs,
            domNodes: countDomNodes(),
            interactiveWords: countInteractiveWords(),
            analyze: state.analyze
        },
        longtask: {
            supported: longtask.supported,
            unavailable: longtask.unavailable,
            count: longtask.count,
            totalMs: roundMs(longtask.totalMs),
            maxMs: roundMs(longtask.maxMs),
            countOver200: longtask.countOver200,
            totalOver200Ms: roundMs(longtask.totalOver200Ms),
            entries: longtask.entries.slice(-50)
        },
        wordTooltip: {
            ...word,
            samples: state.wordSamples.slice(-MAX_SAMPLES)
        },
        readingChunks: summarizeReadingChunks(),
        assistant: {
            turns: state.assistantTurns.map((turn) => ({
                ...turn,
                requestCount: turn.requestCount > 0 ? turn.requestCount : null,
                unavailable: turn.requestCount > 0 ? turn.unavailable : [...turn.unavailable, 'requestCount']
            }))
        },
        measures,
        limitations: [...LIMITATIONS]
    };
}

/** 下載本地 JSON；不呼叫任何網路端點。 */
export function download() {
    if (!ENABLED) return false;
    try {
        const data = JSON.stringify(snapshot(), null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        link.href = url;
        link.download = `bdc-perf-${stamp}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => {
            try { URL.revokeObjectURL(url); } catch (_) { /* noop */ }
        }, 1000);
        return true;
    } catch (_) {
        return false;
    }
}

/** 同一頁重跑前清空樣本（long task 自頁面載入起累計，不重設）。 */
export function reset() {
    if (!ENABLED) return;
    state.wordSamples = [];
    state.readingChunks = [];
    state.assistantTurns = [];
    state.activeTurn = null;
    state.analyze = null;
}
