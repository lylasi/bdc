// 拆音入口：單詞本與學習模式的按鈕都打開同一個彈窗（內容見 word-sheet.js）。
// 舊版以 <dialog> + iframe 內嵌 phonetics.html，已由彈窗取代；
// phonetics.html 仍可作為獨立工具直接開啟（彈窗內提供連結）。
import * as dom from '../../modules/dom.js';
import { loadGlobalSettings } from '../../modules/settings.js';
import { stopCurrentAudio } from '../../modules/audio.js';
import { openPhoneticsSheet } from './word-sheet.js';

let selectedWord = null;

function refresh() {
    if (dom.phoneticsOpen) {
        dom.phoneticsOpen.hidden = loadGlobalSettings().phonetics?.enabled !== true || !selectedWord;
    }
}

export function setPhoneticsWord(word) {
    selectedWord = word || null;
    refresh();
}

/** 以指定單詞（字串或詞條物件）打開拆音彈窗 */
export function openPhonetics(entry) {
    if (!entry || loadGlobalSettings().phonetics?.enabled !== true) return;
    stopCurrentAudio();
    return openPhoneticsSheet(entry);
}

export function initPhonetics() {
    refresh();
    dom.phoneticsOpen?.addEventListener('click', () => openPhonetics(selectedWord));
    document.addEventListener('bdc:settings-change', refresh);
    window.addEventListener('storage', event => {
        if (event.key === 'pen_global_settings') refresh();
    });
}
