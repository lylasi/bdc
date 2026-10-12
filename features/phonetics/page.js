import * as dom from './page-dom.js';
import { renderArt } from './art-viewer.js';
import { initI18n, t } from '../../modules/i18n.js';
import { loadGlobalSettings } from '../../modules/settings.js';
import { buildTTSUrl } from '../../modules/audio.js';
import { getWordPronunciations } from '../../modules/api.js';
import { cleanIPA, validIPA, validWord, normalizePronunciationText, voiceForAccent, practiceTokens } from '../../modules/phonetics-data.js';

initI18n();
document.title = t('phonetics.title');
let current = null, request = 0, controller = null, playback = 0, active = null;
const initial = new URLSearchParams(location.search);
const requested = initial.get('accent');
const originalWord = normalizePronunciationText(initial.get('word'));
const originalReference = cleanIPA(initial.get('referenceIPA') || (!['uk','us'].includes(requested) ? initial.get('ipa') : ''));
let accent = ['uk', 'us'].includes(requested) ? requested : loadGlobalSettings().reading?.englishVariant === 'en-US' ? 'us' : 'uk';
dom.accentInputs.forEach(input => { input.checked = input.value === accent; });
function status(key, error = false) {
    dom.status.textContent = key ? t('phonetics.' + key) : '';
    dom.status.dataset.error = String(error);
}
function audioStatus(key, error = false, values = {}) {
    dom.audioStatus.textContent = key ? t('phonetics.' + key, values) : '';
    dom.audioStatus.dataset.error = String(error);
}
function stop() {
    playback++;
    if (active) active.cancel();
    active = null;
    for (const button of dom.sounds.children) button.classList.remove('active');
    audioStatus('');
}
function fileAudio(path) { return new URL('../../phonetic-chart/' + path, import.meta.url).href; }
function playFile(url) {
    return new Promise((resolve, reject) => {
        const audio = new Audio(url);
        let settled = false;
        const finish = error => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            audio.pause();
            audio.onplaying = audio.onended = audio.onerror = null;
            if (active?.audio === audio) active = null;
            error ? reject(error) : resolve();
        };
        const timer = setTimeout(() => finish(new Error('timeout')), 20000);
        active = {audio, cancel: () => finish(new DOMException('Cancelled', 'AbortError'))};
        audio.onended = () => finish();
        audio.onerror = () => finish(new Error('audio'));
        audio.onplaying = () => audioStatus('playing');
        audioStatus('loadingAudio');
        try { audio.play()?.catch(error => finish(error)); } catch (error) { finish(error); }
    });
}
async function playPaths(paths, buttons = []) {
    stop();
    const version = playback;
    try {
        for (let i = 0; i < paths.length; i++) {
            if (version !== playback) return;
            buttons[i]?.classList.add('active');
            await playFile(paths[i]);
            buttons[i]?.classList.remove('active');
        }
        if (version === playback) audioStatus('done');
    } catch (error) {
        if (version === playback && error.name !== 'AbortError') audioStatus('audioFailed', true);
    }
}
function selectReading(reading) {
    stop();
    current.reading = reading;
    current.tokens = practiceTokens(reading.ipa, accent, current.word, window.WordSplit.tokenize);
    dom.ipa.textContent = '/' + reading.ipa + '/';
    dom.source.textContent = t('phonetics.' + reading.source);
    dom.sounds.replaceChildren(); dom.art.replaceChildren();
    const sounds = current.tokens.filter(token => token.type === 'sound');
    for (const token of current.tokens) {
        const el = document.createElement(token.type === 'sound' ? 'button' : 'span');
        el.textContent = token.optional ? `(${token.symbol})` : token.symbol;
        if (token.type === 'mark' && /\s/u.test(token.symbol)) {
            el.className = 'sound-word-gap';
            el.setAttribute('aria-hidden', 'true');
        }
        if (token.optional) el.title = t('phonetics.optional');
        if (token.type === 'sound') {
            el.type = 'button';
            el.addEventListener('click', () => {
                dom.art.replaceChildren();
                const articulation = token.card && window.getArticulation(token.card, accent);
                renderArt((articulation?.frames || []).map(frame => ({src: fileAudio(frame.asset), alt: frame.alt})));
                if (!token.variant?.audio) { stop(); audioStatus('missing', false, {symbol: token.symbol}); return; }
                playPaths([fileAudio(token.variant.audio)], [el]);
            });
        }
        dom.sounds.append(el);
    }
    dom.soundLabel.hidden = !sounds.length;
    dom.sequence.hidden = !sounds.length;
    // Share only word, accent and provenance; never a credential-bearing audio URL.
    const params = reading.source === 'reference'
        ? new URLSearchParams({word: current.word, accent, referenceIPA: reading.ipa})
        : new URLSearchParams({word: current.word, accent, ipa: reading.ipa, source: reading.source});
    history.replaceState(null, '', '?' + params);
}
async function search({ provided = null, reference = '', refresh = false } = {}) {
    stop(); controller?.abort(); controller = new AbortController();
    const signal = controller.signal, version = ++request;
    const word = normalizePronunciationText(dom.wordInput.value);
    dom.options.replaceChildren(); dom.sounds.replaceChildren(); dom.art.replaceChildren();
    dom.ipa.textContent = ''; dom.source.textContent = '';
    dom.soundLabel.hidden = dom.sequence.hidden = true;
    dom.reference.hidden = true;
    current = null; dom.result.hidden = true;
    if (!validWord(word)) { status('invalid', true); return; }
    current = {word, tokens:[]}; dom.result.hidden = false; dom.title.textContent = word;
    history.replaceState(null, '', '?' + new URLSearchParams({word, accent}));
    reference = reference || (word === originalWord ? originalReference : '');
    if (validIPA(reference)) { dom.reference.hidden = false; dom.reference.textContent = t('phonetics.unknown', {ipa:reference}); }
    if (provided && validIPA(provided.ipa)) { selectReading(provided); status(''); return; }
    if (validIPA(reference)) { selectReading({ipa:reference, source:'reference'}); status(''); return; }
    const local = window.WordSplit.lookup(word, accent);
    if (!local.error) { selectReading({ipa:local.recording.ipa, source:'local'}); status(''); return; }
    status('loading');
    try {
        const readings = await getWordPronunciations(word, accent, {signal, refresh});
        if (version !== request || signal.aborted) return;
        if (!readings.length) { status('noResult'); return; }
        if (readings.length === 1) { selectReading(readings[0]); status(''); }
        else {
            status('choose');
            for (const reading of readings) {
                const button = document.createElement('button');button.type = 'button';
                button.textContent = `/${reading.ipa}/ ${reading.pos} ${reading.meaning}`;
                button.addEventListener('click', () => {
                    if (version !== request) return;
                    selectReading(reading); status('');
                });
                dom.options.append(button);
            }
        }
    } catch (error) {
        if (version !== request || signal.aborted) return;
        const key = error.name === 'AbortError' ? 'failedTimeout'
            : [401,403].includes(error.status) ? 'failedAuth'
            : error.code === 'pronunciation_invalid_response' ? 'failedFormat'
            : error instanceof TypeError ? 'failedNetwork' : 'failed';
        status(key, true);
    }
}
dom.form.addEventListener('submit', event => { event.preventDefault(); search({refresh:true}); });
dom.accentInputs.forEach(input => input.addEventListener('change', () => {
    accent = input.value;
    if (dom.wordInput.value.trim()) search(); else stop();
}));
dom.play.addEventListener('click', () => {
    if (!current) return;
    stop();
    let voice;
    try { voice = voiceForAccent(loadGlobalSettings(), accent); }
    catch { audioStatus('badVoice', true); return; }
    const url = buildTTSUrl(current.word, voice);
    if (location.protocol === 'https:' && new URL(url).protocol === 'http:') { audioStatus('mixed', true); return; }
    playPaths([url]);
});
dom.sequence.addEventListener('click', () => {
    const tokens = current?.tokens.filter(token => token.type === 'sound' && !token.optional) || [];
    const missing = tokens.find(token => !token.variant?.audio);
    if (missing) { stop(); audioStatus('missing', false, {symbol:missing.symbol}); return; }
    playPaths(tokens.map(token => fileAudio(token.variant.audio)), [...dom.sounds.querySelectorAll('button')].filter((_, index) => !current.tokens.filter(token => token.type === 'sound')[index].optional));
});
dom.stop.addEventListener('click', stop);
window.addEventListener('pagehide', () => { stop(); controller?.abort(); request++; });
document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
window.addEventListener('storage', event => {
    if (event.key === 'pen_global_settings' || event.key === 'pen_global_secrets') {
        stop(); controller?.abort(); request++; initI18n();document.title = t('phonetics.title');
        if (dom.wordInput.value.trim()) search();
    }
});
if (initial.has('word')) {
    dom.wordInput.value = initial.get('word');
    const ipa = cleanIPA(initial.get('ipa'));
    const source = initial.get('source') === 'ai' ? 'ai' : initial.get('source') === 'local' ? 'local' : 'provided';
    search({provided: ['uk','us'].includes(requested) && validIPA(ipa) ? {ipa, source} : null,
        reference: cleanIPA(initial.get('referenceIPA') || (!requested ? ipa : ''))});
}
