(() => {
  'use strict';
  function cleanIPA(value) {
    return typeof value === 'string' ? value.trim().replace(/^\/(.*)\/$/u, '$1').replace(/^\[(.*)\]$/u, '$1').trim().normalize('NFC') : '';
  }
  function readParams(query) {
    const params = new URLSearchParams(query);
    const fields = ['word','ipa','accent','audioUrl'];
    for (const key of fields) if (params.getAll(key).length > 1) return {error:`参数 ${key} 不能重复。`};
    return Object.fromEntries(fields.filter(key => params.has(key)).map(key => [key,params.get(key)]));
  }
  function resolve(input) {
    if (input.error) return input;
    const word = window.WordSplit.normalize(input.word);
    const suppliedIPA = Object.prototype.hasOwnProperty.call(input,'ipa');
    const ipa = cleanIPA(input.ipa);
    const accent = input.accent || (suppliedIPA ? '' : 'uk');
    if (!['uk','us'].includes(accent)) return {error:'请用 accent=uk 或 accent=us 指定口音。'};
    if (word && (word.length > 80 || !/^[a-z]+(?:['-][a-z]+)*$/.test(word))) return {error:'word 必须是一个英文单词。'};
    if (suppliedIPA && (!ipa || ipa.length > 160 || /[<>\u0000-\u001f]/u.test(ipa))) return {error:'ipa 不能为空、超过 160 字符或包含无效字符。'};
    if (!word && !suppliedIPA) return {error:'请提供 word 或 ipa。'};
    let audioUrl = null;
    if (Object.prototype.hasOwnProperty.call(input,'audioUrl')) {
      try {
        const url = new URL(input.audioUrl);
        if (!['http:','https:'].includes(url.protocol) || url.username || url.password || input.audioUrl.length > 4096) throw new Error();
        if (window.location?.protocol === 'https:' && url.protocol !== 'https:') throw new Error();
        audioUrl = url.href;
      } catch { return {error:'audioUrl 必须是可直接播放的 HTTP(S) 地址，HTTPS 页面请使用 HTTPS 音频。'}; }
      if (!word) return {error:'传入整词录音时请同时提供 word。'};
    }
    const local = word ? window.WordSplit.lookup(word,accent) : null;
    if (!suppliedIPA && local?.error) return local;
    const match = local && !local.error && (!suppliedIPA || cleanIPA(local.recording.ipa) === ipa);
    const recording = match ? {...local.recording} : {ipa, audio:null};
    if (suppliedIPA) recording.ipa = ipa;
    if (audioUrl) { recording.audio = audioUrl; delete recording.sourceUrl; }
    const tokens = window.WordSplit.tokenize(recording.ipa, accent, word);
    if (!tokens.some(token => token.type === 'sound')) return {error:'ipa 中没有可练习的音素。'};
    const unsupported = [...new Set(tokens.filter(token => token.type === 'sound' && !token.variant?.audio).map(token=>token.symbol))];
    const notices = [];
    if (suppliedIPA) notices.push('使用传入音标');
    if (audioUrl) notices.push('整词音频由链接提供');
    if (!recording.audio) notices.push('整词录音暂无，可逐音练习');
    if (unsupported.length) notices.push(`暂不支持独立示范：${unsupported.map(s=>`/${s}/`).join('、')}`);
    return {word, accent, recording, tokens, notices, suppliedIPA, audioUrl, input:{...input}};
  }
  function toQuery(entry) {
    const params = new URLSearchParams();
    if (entry.word) params.set('word',entry.word);
    params.set('accent',entry.accent);
    if (entry.suppliedIPA) params.set('ipa',entry.recording.ipa);
    if (entry.audioUrl) params.set('audioUrl',entry.audioUrl);
    return params.toString();
  }
  window.WordEntry = {readParams, resolve, toQuery, cleanIPA};
})();
