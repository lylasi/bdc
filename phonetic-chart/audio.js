(() => {
  'use strict';
  let active = null;
  const canceled = () => new DOMException('已停止播放', 'AbortError');
  const emit = (type, detail) => window.dispatchEvent(new CustomEvent(type, {detail}));
  window.stopPhoneme = () => { if (active) active.cancel(); };

  function playFile(item, event, detail) {
    return new Promise((resolve, reject) => {
      const audio = new Audio(item.audio);
      audio.preload = 'auto';
      let settled = false;
      const timer = setTimeout(() => finish(new Error('音频加载或播放超时，请重试。')), 15000);
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        audio.pause();
        audio.onended = audio.onerror = audio.onplaying = null;
        if (active?.audio === audio) active = null;
        error ? reject(error) : resolve();
      };
      active = {audio, cancel: () => finish(canceled())};
      audio.onended = () => finish();
      audio.onerror = () => finish(new Error('无法读取示范录音，请确认音频文件完整后重试。'));
      audio.onplaying = () => { if (!settled) emit(event, detail); };
      try {
        const started = audio.play();
        if (started?.catch) started.catch(error => finish(new Error(
          error.name === 'NotAllowedError' ? '浏览器阻止了声音，请再次点击播放。' : '播放失败，请再次点击重试。'
        )));
      } catch (error) { finish(error); }
    });
  }
  window.playPhoneme = (item) => {
    window.stopPhoneme();
    if (!item?.audio) return Promise.reject(new Error('这个音标还没有示范录音。'));
    return playFile(item, 'phoneme:playing', {id:item.id});
  };
  window.getWordAudio = (word, accent) => {
    const clean = typeof word === 'string' ? word.trim().toLowerCase() : '';
    if (!/^[a-z]+(?:['-][a-z]+)*$/.test(clean) || !['uk','us'].includes(accent)) return null;
    const catalog = window.WORD_RECORDINGS?.[accent];
    const recording = catalog && Object.prototype.hasOwnProperty.call(catalog, clean) ? catalog[clean] : null;
    return {...recording, id:`word-${accent}-${clean}`, word:clean, accent,
      audio:recording?.audio || null, ipa:recording?.ipa || '',
      kind:recording?.audio ? 'recording' : 'unavailable',
      label:recording?.audio ? '真人' : '待补'};
  };
  window.playWordRecording = item => {
    window.stopPhoneme();
    if (!item?.audio) return Promise.reject(new Error('这个词的整词录音暂无。'));
    return playFile(item, 'word:playing', item);
  };
  window.playWord = (word, accent) => {
    window.stopPhoneme();
    const item = window.getWordAudio(word, accent);
    if (!item) return Promise.reject(new Error('请选择有效例词和英音或美音。'));
    // A missing recording must not silently become a device-dependent synthetic voice.
    if (!item.audio) return Promise.reject(new Error(`这个例词的${accent === 'uk' ? '英音' : '美音'}真人录音尚未补齐。`));
    return playFile(item, 'word:playing', item);
  };
  window.addEventListener('pagehide', window.stopPhoneme);
})();
