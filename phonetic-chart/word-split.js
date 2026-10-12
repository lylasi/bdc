(() => {
  'use strict';
  const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
  function inventory(accent) {
    const sounds = new Map();
    for (const card of window.PHONEME_CARDS) {
      const variant = card.variants[accent];
      if (variant && !sounds.has(variant.symbol)) sounds.set(variant.symbol, {card, variant});
    }
    return sounds;
  }
  function tokenize(ipa, accent, word = '') {
    const sounds = inventory(accent);
    const symbols = [...sounds.keys(), 'i'].sort((a,b) => b.length-a.length);
    // In very, r starts the following syllable; it is not the /er/ of hair.
    const parts = word === 'very' && ipa === 'ˈveri' ? ['ˈ','v','e','r','i'] : null;
    const tokens = [];
    let remaining = ipa;
    while (remaining.length) {
      const symbol = parts ? parts[tokens.length] : symbols.find(s => remaining.startsWith(s)) || [...remaining][0];
      if (!symbol || !remaining.startsWith(symbol)) throw new Error('音标分段与来源不一致。');
      const sound = sounds.get(symbol);
      tokens.push({symbol, type: /^[ˈˌ.\s]$/.test(symbol) ? 'mark' : 'sound', card:sound?.card || null, variant:sound?.variant || null});
      remaining = remaining.slice(symbol.length);
    }
    return tokens;
  }
  function lookup(value, accent) {
    const word = normalize(value);
    if (!['uk','us'].includes(accent)) return {error:'请选择英音或美音。'};
    if (!/^[a-z]+(?:['-][a-z]+)*$/.test(word)) return {error:'请输入一个英文单词，例如 ship。'};
    const catalog = window.WORD_RECORDINGS[accent];
    if (!Object.prototype.hasOwnProperty.call(catalog, word)) return {code:"not_found", error:`暂未收录 ${word}。试试下方示例，或展开已收录词表。`};
    const recording = catalog[word];
    return {word, accent, recording, tokens:tokenize(recording.ipa, accent, word)};
  }
  window.WordSplit = {normalize, tokenize, lookup};
})();
