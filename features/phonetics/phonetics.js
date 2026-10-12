import * as dom from '../../modules/dom.js';
import { loadGlobalSettings } from '../../modules/settings.js';
import { stopCurrentAudio } from '../../modules/audio.js';
import { entryQuery } from '../../modules/phonetics-data.js';

let selectedWord = null;
function refresh() {
    if (dom.phoneticsOpen) dom.phoneticsOpen.hidden = loadGlobalSettings().phonetics?.enabled !== true || !selectedWord;
}
function close() {
    if (dom.phoneticsDialog?.open) dom.phoneticsDialog.close();
    if (dom.phoneticsFrame) dom.phoneticsFrame.src = 'about:blank';
}
export function setPhoneticsWord(word) {
    selectedWord = word;
    close();
    refresh();
}
export function openPhonetics(word) {
    if (!word || loadGlobalSettings().phonetics?.enabled !== true) return;
    stopCurrentAudio();
    const accent = loadGlobalSettings().reading?.englishVariant === 'en-US' ? 'us' : 'uk';
    const url = new URL('../../phonetics.html', import.meta.url);
    url.search = entryQuery(word, accent).toString();
    dom.phoneticsIndependent.href = url.href;
    dom.phoneticsFrame.src = url.href;
    dom.phoneticsDialog.showModal();
}
export function initPhonetics() {
    refresh();
    dom.phoneticsOpen.addEventListener('click', () => openPhonetics(selectedWord));
    dom.phoneticsIndependent.addEventListener('click', () => {
        const current = dom.phoneticsFrame.contentWindow?.location;
        if (current?.origin === location.origin && current.pathname.endsWith('/phonetics.html')) {
            dom.phoneticsIndependent.href = current.href;
        }
    });
    dom.phoneticsClose.addEventListener('click', close);
    dom.phoneticsDialog.addEventListener('close', () => { dom.phoneticsFrame.src = 'about:blank'; });
    document.addEventListener('bdc:settings-change', () => { close(); refresh(); });
    window.addEventListener('storage', event => { if (event.key === 'pen_global_settings' || event.key === 'pen_global_secrets') { close(); refresh(); } });
    window.addEventListener('pagehide', close);
}
