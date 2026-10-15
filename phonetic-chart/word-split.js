(() => {
  'use strict';
  const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
  const MARK = /^[ˈˌ.\s]$/u;
  // 鼻化、成音節、送氣等修飾符跟在某個音後面時，附在那個音上顯示，
  // 不另外變成一個查不到示範的音。
  const MODIFIER = /^[\u02b0-\u02ff\u0300-\u036f]+/u;
  // 同一個音的其他常見寫法（不同字典或 AI 的記法）→ 本應用音標表已有的示範音。
  // 卡片資料上的 aliases 會自動一併納入，這裡只補 aliases 沒涵蓋的寫法。
  const WRITINGS = {
    uk: { 'ɹ': 'r', 'ʧ': 'tʃ', 'ʤ': 'dʒ', 'ɫ': 'l', 'ɜ': 'ɜː', 'oʊ': 'əʊ' },
    us: {
      'ɹ': 'r', 'ʧ': 'tʃ', 'ʤ': 'dʒ', 'ɫ': 'l', 'ɜ': 'ɜːr', 'ɜː': 'ɜːr',
      'ɒ': 'ɑː', 'əʊ': 'oʊ', 'ɪə': 'ɪr', 'eə': 'er', 'ʊə': 'ʊr'
    }
  };
  // 本應用的寫法 → {card, variant}
  function canonical(accent) {
    const sounds = new Map();
    for (const card of window.PHONEME_CARDS) {
      const variant = card.variants[accent];
      if (variant && !sounds.has(variant.symbol)) sounds.set(variant.symbol, {card, variant});
    }
    return sounds;
  }
  // 連同「其他常見寫法」一起索引，AI 回傳 /ɛ/、/i/、/ɹ/、/ɚ/ 等寫法時仍能找到示範音。
  function inventory(accent) {
    const base = canonical(accent);
    const sounds = new Map(base);
    const add = (notation, symbol) => {
      const entry = base.get(symbol);
      if (entry && notation && !sounds.has(notation)) sounds.set(notation, entry);
    };
    for (const card of window.PHONEME_CARDS) {
      const variant = card.variants[accent];
      if (!variant) continue;
      // 同一張卡片的兩種口音變體都看：其他寫法可能只記在另一邊。
      for (const other of Object.values(card.variants)) {
        if (!other) continue;
        add(other.sourceSymbol, variant.symbol);
        for (const alias of other.aliases || []) add(alias, variant.symbol);
      }
    }
    for (const [notation, symbol] of Object.entries(WRITINGS[accent] || {})) add(notation, symbol);
    return sounds;
  }
  function tokenize(ipa, accent, word = '') {
    const sounds = inventory(accent);
    const symbols = [...sounds.keys()].sort((a,b) => b.length-a.length);
    // In very, r starts the following syllable; it is not the /er/ of hair.
    const parts = word === 'very' && ipa === 'ˈveri' ? ['ˈ','v','e','r','i'] : null;
    const tokens = [];
    let remaining = ipa;
    while (remaining.length) {
      const symbol = parts ? parts[tokens.length] : symbols.find(s => remaining.startsWith(s)) || [...remaining][0];
      if (!symbol || !remaining.startsWith(symbol)) throw new Error('音标分段与来源不一致。');
      const sound = sounds.get(symbol);
      const mark = MARK.test(symbol);
      let shown = symbol;
      remaining = remaining.slice(symbol.length);
      if (sound && !mark) {
        const modifier = MODIFIER.exec(remaining)?.[0];
        if (modifier) { shown += modifier; remaining = remaining.slice(modifier.length); }
      }
      tokens.push({
        symbol: shown,
        type: mark ? 'mark' : 'sound',
        card: sound?.card || null,
        variant: sound?.variant || null,
        // 真的不在音標表裡：UI 會標成「暫無獨立示範」，不會當成壞掉的音。
        unmatched: !sound
      });
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
