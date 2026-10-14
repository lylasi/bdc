// 單詞拆音彈窗（單詞本／學習模式入口）
// 只呈現「這一個單詞」的拆解：音標 + 逐音示範 + 發音口型圖。
// 查詞表單、完整音標表等留在獨立頁 phonetics.html（彈窗內提供前往連結）。
import * as dom from '../../modules/dom.js';
import * as ui from '../../modules/ui.js';
import { t } from '../../modules/i18n.js';
import { loadGlobalSettings } from '../../modules/settings.js';
import * as audio from '../../modules/audio.js';
import { getWordPronunciations } from '../../modules/api.js';
import { cleanIPA, validIPA, validWord, normalizePronunciationText, voiceForAccent, practiceTokens } from '../../modules/phonetics-data.js';

// 拆音引擎（全域腳本）只在第一次打開彈窗時載入，開頁不受影響
const ENGINE_SCRIPTS = [
    'phonetic-chart/data.js',
    'phonetic-chart/word-audio.js',
    'phonetic-chart/word-split.js',
    'phonetic-chart/articulation.js'
];
const PHONETIC_BASE = new URL('../../phonetic-chart/', import.meta.url);

const scriptPromises = new Map();
function loadScriptOnce(src) {
    if (!scriptPromises.has(src)) {
        scriptPromises.set(src, new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.async = true;
            script.onload = () => resolve();
            script.onerror = () => { scriptPromises.delete(src); reject(new Error(`無法載入 ${src}`)); };
            document.head.appendChild(script);
        }));
    }
    return scriptPromises.get(src);
}

let enginePromise = null;
function ensureEngine() {
    if (enginePromise) return enginePromise;
    enginePromise = (async () => {
        for (const src of ENGINE_SCRIPTS) await loadScriptOnce(src);
    })();
    enginePromise.catch(() => { enginePromise = null; });
    return enginePromise;
}

const assetUrl = path => new URL(path, PHONETIC_BASE).href;

// ===== 播放控制（同時間只留一個聲音） =====
let activeAudio = null;
function stopAudio() {
    if (activeAudio) {
        try { activeAudio.pause(); } catch (_) { /* ignore */ }
        activeAudio = null;
    }
    document.querySelectorAll('.ps-sounds .is-playing').forEach(el => el.classList.remove('is-playing'));
}
function playUrl(url, button = null) {
    stopAudio();
    return new Promise((resolve) => {
        const element = new Audio(url);
        activeAudio = element;
        button?.classList.add('is-playing');
        const done = () => {
            if (activeAudio === element) activeAudio = null;
            button?.classList.remove('is-playing');
            resolve();
        };
        element.onended = done;
        element.onerror = done;
        try { element.play()?.catch(done); } catch (_) { done(); }
    });
}

// ===== 畫面狀態 =====
let session = 0;
let activeState = null;   // 目前彈窗的狀態物件（關閉時用來中止請求）
let modalObserver = null;

function stopSession() {
    stopAudio();
    audio.stopCurrentAudio();
    session++;
    try { activeState?.controller?.abort(); } catch (_) { /* ignore */ }
    activeState = null;
}

function watchModalClose() {
    if (modalObserver || !dom.appModal) return;
    modalObserver = new MutationObserver(() => {
        if (dom.appModal.classList.contains('hidden')) stopSession();
    });
    modalObserver.observe(dom.appModal, { attributes: true, attributeFilter: ['class'] });
}

// ===== 讀法解析 =====
function buildTokens(ipa, accent, word) {
    try {
        return practiceTokens(ipa, accent, word, window.WordSplit.tokenize);
    } catch (_) {
        return [];
    }
}

async function resolveReading(state, { allowProvided }) {
    const { word, accent, entry } = state;

    const local = window.WordSplit?.lookup(word, accent);
    if (local && !local.error) {
        return { ipa: local.recording.ipa, source: 'local', accent, tokens: local.tokens };
    }

    const provided = cleanIPA(entry?.phonetic);
    if (allowProvided && validIPA(provided)) {
        const tokens = buildTokens(provided, accent, word);
        if (tokens.length) {
            return { ipa: provided, source: entry?.phoneticSource === 'ai' ? 'ai' : 'provided', accent, tokens };
        }
    }

    state.controller = new AbortController();
    const readings = await getWordPronunciations(word, accent, { signal: state.controller.signal });
    if (!readings.length) return null;
    // 只有一種讀法就直接用，多種才讓使用者選
    if (readings.length === 1) {
        return { ipa: readings[0].ipa, source: 'ai', accent, tokens: buildTokens(readings[0].ipa, accent, word) };
    }
    return { readings };
}

// 切換英/美音時：先找該口音的本地讀法；找不到就沿用目前音標，
// 只把「試聽示範」換成該口音（不改寫音標，也不再打 AI 查詢）。
function switchAccentReading(state) {
    const local = window.WordSplit?.lookup(state.word, state.accent);
    if (local && !local.error) {
        state.reading = { ipa: local.recording.ipa, source: 'local', accent: state.accent };
        state.tokens = local.tokens;
        return true;
    }
    const alt = buildTokens(state.reading.ipa, state.accent, state.word);
    const playable = alt.length && alt.every(token => token.type !== 'sound' || token.variant?.audio);
    if (playable) state.tokens = alt; // 這個口音每個音都有示範音，才換過去
    return false;
}

// ===== 渲染 =====
function renderShell() {
    const sheet = document.createElement('div');
    sheet.className = 'phonetics-sheet';
    sheet.innerHTML = `
        <div class="ps-head">
            <div class="ps-title">
                <strong class="ps-word"></strong>
                <span class="ps-ipa"></span>
            </div>
            <div class="ps-accents" role="group" aria-label="${t('phonetics.title')}">
                <button type="button" class="ps-accent" data-accent="uk">${t('phonetics.uk')}</button>
                <button type="button" class="ps-accent" data-accent="us">${t('phonetics.us')}</button>
            </div>
        </div>
        <p class="ps-source" hidden></p>
        <div class="ps-actions">
            <button type="button" class="btn primary ps-play">${t('phonetics.play')}</button>
            <button type="button" class="btn secondary ps-stop">${t('phonetics.stop')}</button>
            <button type="button" class="btn secondary ps-sequence" hidden>${t('phonetics.sequence')}</button>
            <button type="button" class="btn secondary ps-retry" hidden>${t('phonetics.retry')}</button>
        </div>
        <p class="ps-status" role="status" aria-live="polite"></p>
        <div class="ps-choices"></div>
        <div class="ps-sounds"></div>
        <p class="ps-optional" hidden>${t('phonetics.optional')}</p>
        <div class="ps-art" hidden></div>
        <a class="ps-standalone" target="_blank" rel="noopener">${t('phonetics.independent')}</a>
    `;
    return sheet;
}

function setStatus(sheet, key, error = false, values = {}) {
    const el = sheet.querySelector('.ps-status');
    el.textContent = key ? t('phonetics.' + key, values) : '';
    el.dataset.error = String(error);
}

function renderSounds(sheet, state) {
    const container = sheet.querySelector('.ps-sounds');
    const art = sheet.querySelector('.ps-art');
    container.replaceChildren();
    art.hidden = true;
    art.replaceChildren();

    const sounds = state.tokens.filter(token => token.type === 'sound');
    const mark = /^\s$/;
    for (const token of state.tokens) {
        const el = document.createElement(token.type === 'sound' ? 'button' : 'span');
        if (token.type === 'sound') el.type = 'button';
        el.textContent = token.optional ? `(${token.symbol})` : token.symbol;
        el.className = token.type === 'sound' ? 'ps-sound' : 'ps-mark';
        if (token.type === 'mark' && mark.test(token.symbol)) el.classList.add('is-gap');
        if (token.optional) el.title = t('phonetics.optional');
        if (token.type === 'sound') {
            el.setAttribute('aria-label', token.symbol);
            el.addEventListener('click', () => {
                renderArt(sheet, token, state.accent);
                if (!token.variant?.audio) {
                    stopAudio();
                    setStatus(sheet, 'missing', false, { symbol: token.symbol });
                    return;
                }
                playUrl(assetUrl(token.variant.audio), el);
            });
        }
        container.appendChild(el);
    }

    sheet.querySelector('.ps-sequence').hidden = !sounds.length;
    sheet.querySelector('.ps-optional').hidden = !state.tokens.some(token => token.optional);
}

function renderArt(sheet, token, accent) {
    const container = sheet.querySelector('.ps-art');
    container.replaceChildren();
    container.hidden = true;
    const profile = token.card && window.getArticulation?.(token.card, accent);
    if (!profile?.frames?.length) return;

    const heading = document.createElement('p');
    heading.className = 'ps-art-title';
    heading.textContent = profile.title || '';
    container.appendChild(heading);

    const strip = document.createElement('div');
    strip.className = 'ps-art-strip';
    for (const frame of profile.frames) {
        const figure = document.createElement('figure');
        const img = document.createElement('img');
        img.src = assetUrl(frame.asset);
        img.alt = frame.alt || frame.label || '';
        img.loading = 'lazy';
        const caption = document.createElement('figcaption');
        caption.textContent = frame.label || '';
        figure.append(img, caption);
        strip.appendChild(figure);
    }
    container.appendChild(strip);
    container.hidden = false;
}

function renderReading(sheet, state) {
    const { reading } = state;
    sheet.querySelector('.ps-word').textContent = state.word;
    const ipaEl = sheet.querySelector('.ps-ipa');
    ipaEl.textContent = reading.ipa ? `/${reading.ipa}/` : '';

    const source = sheet.querySelector('.ps-source');
    if (reading.source) {
        source.textContent = accentUnconfirmed(reading, state)
            ? `${t('phonetics.' + reading.source)} · ${t('phonetics.accentDemoOnly')}`
            : t('phonetics.' + reading.source);
        source.hidden = false;
    } else {
        source.hidden = true;
    }

    sheet.querySelector('.ps-choices').replaceChildren();

    if (state.tokens.length) {
        renderSounds(sheet, state);
    } else {
        sheet.querySelector('.ps-sounds').replaceChildren();
        sheet.querySelector('.ps-sequence').hidden = true;
        sheet.querySelector('.ps-optional').hidden = true;
        setStatus(sheet, 'failed');
    }

    sheet.querySelector('.ps-play').disabled = false;
    sheet.querySelector('.ps-stop').disabled = false;
    sheet.querySelector('.ps-retry').hidden = !accentUnconfirmed(reading, state);
    updateStandaloneLink(sheet, state);
}

// 目前顯示的音標不是這個口音的（詞條音標或 AI 讀法）→ 可另外查詢
function accentUnconfirmed(reading, state) {
    return !!reading && reading.source !== 'local' && reading.accent !== state.accent;
}

function updateStandaloneLink(sheet, state) {
    const link = sheet.querySelector('.ps-standalone');
    const url = new URL('../../phonetics.html', import.meta.url);
    const params = new URLSearchParams({ word: state.word, accent: state.accent });
    const ipa = cleanIPA(state.reading?.ipa);
    if (ipa && state.reading?.source !== 'local') {
        params.set('ipa', ipa);
        params.set('source', state.reading?.source === 'ai' ? 'ai' : 'provided');
    }
    url.search = params.toString();
    link.href = url.href;
}

function renderChoices(sheet, state, readings) {
    state.reading = null;
    sheet.querySelector('.ps-ipa').textContent = '';
    sheet.querySelector('.ps-source').hidden = true;
    sheet.querySelector('.ps-sounds').replaceChildren();
    sheet.querySelector('.ps-art').hidden = true;
    sheet.querySelector('.ps-sequence').hidden = true;
    setStatus(sheet, 'choose');
    updateStandaloneLink(sheet, state);

    const container = sheet.querySelector('.ps-choices');
    container.replaceChildren();
    readings.forEach((reading) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ps-choice';
        button.textContent = `/${reading.ipa}/${reading.pos ? ' ' + reading.pos : ''}${reading.meaning ? ' ' + reading.meaning : ''}`;
        button.addEventListener('click', () => {
            const tokens = buildTokens(reading.ipa, state.accent, state.word);
            state.reading = { ipa: reading.ipa, source: 'ai', accent: state.accent, tokens };
            renderReading(sheet, state);
            setStatus(sheet, '');
        });
        container.appendChild(button);
    });
}

async function showReading(sheet, state, { allowProvided }) {
    setStatus(sheet, 'loading');
    let resolved;
    try {
        resolved = await resolveReading(state, { allowProvided });
    } catch (error) {
        if (error?.name === 'AbortError') return false;
        const key = [401, 403].includes(error?.status) ? 'failedAuth'
            : error?.code === 'pronunciation_invalid_response' ? 'failedFormat'
                : error instanceof TypeError ? 'failedNetwork' : 'failed';
        state.lastError = key;
        setStatus(sheet, key, true);
        return false;
    }
    if (session !== state.session) return false;

    if (!resolved) { setStatus(sheet, 'noResult', true); sheet.querySelector('.ps-retry').hidden = false; return false; }
    if (resolved.readings) { renderChoices(sheet, state, resolved.readings); return true; }

    state.tokens = resolved.tokens || buildTokens(resolved.ipa, state.accent, state.word);
    state.reading = { ipa: resolved.ipa, source: resolved.source, accent: resolved.accent || state.accent };
    renderReading(sheet, state);
    setStatus(sheet, '');
    return true;
}

// 使用者主動查詢目前口音的音標（切換口音時不會自動打 AI）
async function fetchAccentReading(sheet, state) {
    setStatus(sheet, 'loading');
    const previous = { reading: state.reading, tokens: state.tokens };
    try {
        state.controller = new AbortController();
        const readings = await getWordPronunciations(state.word, state.accent, { signal: state.controller.signal });
        if (session !== state.session) return;
        if (!readings.length) { setStatus(sheet, 'noResult', true); return; }
        if (readings.length > 1) { renderChoices(sheet, state, readings); return; }
        state.reading = { ipa: readings[0].ipa, source: 'ai', accent: state.accent };
        state.tokens = buildTokens(readings[0].ipa, state.accent, state.word);
        renderReading(sheet, state);
        setStatus(sheet, '');
    } catch (error) {
        if (error?.name === 'AbortError' || session !== state.session) return;
        const key = [401, 403].includes(error?.status) ? 'failedAuth'
            : error?.code === 'pronunciation_invalid_response' ? 'failedFormat'
                : error instanceof TypeError ? 'failedNetwork' : 'failed';
        state.lastError = key;
        // 查不到就保留原本的讀法，只提示失敗
        state.reading = previous.reading;
        state.tokens = previous.tokens;
        if (state.reading) renderReading(sheet, state);
        setStatus(sheet, key, true);
    }
}

function bindSheet(sheet, state) {
    sheet.querySelectorAll('.ps-accent').forEach((button) => {
        button.addEventListener('click', async () => {
            if (button.dataset.accent === state.accent) return;
            state.accent = button.dataset.accent;
            const mark = () => sheet.querySelectorAll('.ps-accent').forEach(b => b.classList.toggle('is-active', b.dataset.accent === state.accent));
            mark();
            stopAudio();

            if (state.reading) {
                switchAccentReading(state);
                renderReading(sheet, state);
                setStatus(sheet, '');
                return;
            }

            // 還沒有任何讀法（例如初次查詢失敗）：這時才需要重新查一次
            const previous = state.accent;
            const ok = await showReading(sheet, state, { allowProvided: true });
            if (ok || session !== state.session) return;
            state.accent = previous;
            mark();
            setStatus(sheet, state.lastError || 'failed', true);
        });
    });

    sheet.querySelector('.ps-play').addEventListener('click', () => {
        stopAudio();
        let voice;
        try { voice = voiceForAccent(loadGlobalSettings(), state.accent); }
        catch (_) { setStatus(sheet, 'badVoice', true); return; }
        setStatus(sheet, 'playing');
        // 沿用 App 的朗讀管線：遠端 TTS 未設定時會自動改用系統語音
        audio.speakText(state.word, voice, 0, null, () => {
            if (session === state.session) setStatus(sheet, '');
        });
    });

    sheet.querySelector('.ps-stop').addEventListener('click', () => {
        stopAudio();
        audio.stopCurrentAudio();
        setStatus(sheet, '');
    });

    sheet.querySelector('.ps-retry').addEventListener('click', () => fetchAccentReading(sheet, state));

    sheet.querySelector('.ps-sequence').addEventListener('click', async () => {
        audio.stopCurrentAudio();
        const tokens = state.tokens.filter(token => token.type === 'sound' && !token.optional);
        const missing = tokens.find(token => !token.variant?.audio);
        if (missing) { stopAudio(); setStatus(sheet, 'missing', false, { symbol: missing.symbol }); return; }
        const buttons = [...sheet.querySelectorAll('.ps-sound')];
        for (let i = 0; i < tokens.length; i++) {
            if (session !== state.session) return;
            await playUrl(assetUrl(tokens[i].variant.audio), buttons[i]);
        }
        if (session === state.session) setStatus(sheet, 'done');
    });
}

/**
 * 打開單詞拆音彈窗。
 * @param {{word: string, phonetic?: string, phoneticSource?: string, phoneticAccent?: string}|string} entry
 */
export async function openPhoneticsSheet(entry) {
    const word = normalizePronunciationText(typeof entry === 'string' ? entry : entry?.word);
    if (!validWord(word)) {
        ui.displayMessage(t('phonetics.invalid'), 'warning');
        return;
    }

    const source = typeof entry === 'string' ? {} : (entry || {});
    const settings = loadGlobalSettings();
    const accent = ['uk', 'us'].includes(source.phoneticAccent)
        ? source.phoneticAccent
        : settings.reading?.englishVariant === 'en-US' ? 'us' : 'uk';
    const state = { word, accent, entry: source, tokens: [], reading: null, controller: null, session: ++session };
    activeState = state;

    ui.openModal();
    if (dom.modalTitle) dom.modalTitle.textContent = t('phonetics.practice');
    if (!dom.modalBody) return;
    watchModalClose();

    const sheet = renderShell();
    dom.modalBody.replaceChildren(sheet);
    sheet.querySelector('.ps-word').textContent = word;
    sheet.querySelector(`.ps-accent[data-accent="${accent}"]`)?.classList.add('is-active');
    bindSheet(sheet, state);

    try {
        await Promise.all([ensureEngine()]);
    } catch (error) {
        console.warn('拆音引擎載入失敗:', error);
        setStatus(sheet, 'lookupUnavailable', true);
        return;
    }
    if (session !== state.session) return;
    await showReading(sheet, state, { allowProvided: true });
}
