const byId = id => document.getElementById(id);
export const form = byId('phonetic-form');
export const wordInput = byId('phonetic-word');
export const status = byId('phonetic-status');
export const reference = byId('phonetic-reference');
export const options = byId('phonetic-options');
export const result = byId('phonetic-result');
export const title = byId('phonetic-title');
export const play = byId('phonetic-play');
export const stop = byId('phonetic-stop');
export const ipa = byId('phonetic-ipa');
export const source = byId('phonetic-source');
export const soundLabel = byId('phonetic-sound-label');
export const sounds = byId('phonetic-sounds');
export const sequence = byId('phonetic-sequence');
export const audioStatus = byId('phonetic-audio-status');
export const accentInputs = [...document.querySelectorAll('[name="accent"]')];

export const art = byId('phonetic-art');

export const viewer = Object.fromEntries(['viewer', 'stage', 'image', 'caption', 'prev', 'next', 'count', 'out', 'reset', 'in', 'close'].map(key => [key, byId('art-' + key)]));
