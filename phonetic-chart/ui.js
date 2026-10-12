/**
 * 英语国际音标乐园 (Phonetic Chart) - 界面交互驱动
 * 适用对象：小学生群体及英语启蒙学习者
 * 遵循牛津学习词典音标习惯，共用符号同卡试听，真实差异并列，原生JS无依赖
 *
 * 数据与音频契约：
 * - window.PHONEME_CARDS = [{ id, category, example, note?, variants: { uk, us } }]
 * - window.playPhoneme(variant) -> Promise
 * - window.stopPhoneme() -> 取消正在播放的音标或单词
 * - window.getWordAudio(word, accent) -> { id, word, accent, audio, kind: 'recording'|'unavailable', label }
 * - window.playWord(word, accent) -> Promise
 * - 事件通知：phoneme:playing, word:playing
 */

(function () {
  'use strict';

  // 全局内部状态
  const state = {
    defaultAccent: 'uk',          // 'uk' | 'us' 顶栏默认试听口音
    inspectorAccent: 'uk',        // 'uk' | 'us' 详情面板当前聚焦口音
    selectedCardId: null,         // 当前选中的 card.id
    selectedCard: null,           // 当前选中的 card 对象
    activePlayingVariantId: null, // 真正发出声音的 variant.id
    loadingVariantId: null,       // 正在调用 playPhoneme 尚未 playing 的 variant.id
    loadingWordKey: null,         // 正在加载中的单词 `${word}-${accent}`
    activePlayingWordKey: null,   // 真正正在发音的单词 `${word}-${accent}`
    wordPlaybackVersion: 0        // 单词播放竞态版本号
  };

  // 音标播放竞态版本号，保障快速连点不发生冲突
  let playbackVersion = 0;

  // 中性分组名称对照 (避免对美音套用英音长短分类)
  const CATEGORY_NAMES = {
    short: '单元音(基础组)',
    long: '单元音(补充组)',
    diphthong: '双元音与英美对应',
    rhotic: '带r音色的元音',
    consonant: '辅音'
  };

  // DOM 节点缓存
  const elements = {
    // 顶栏默认口音切换
    accentBtnUk: document.getElementById('accent-btn-uk'),
    accentBtnUs: document.getElementById('accent-btn-us'),

    // 各分组网格容器
    gridShort: document.getElementById('grid-short'),
    gridLong: document.getElementById('grid-long'),
    gridDiphthong: document.getElementById('grid-diphthong'),
    gridRhotic: document.getElementById('grid-rhotic'),
    gridConsonant: document.getElementById('grid-consonant'),

    // 分组计数标签
    vowelsCount: document.getElementById('vowels-count'),
    consonantsCount: document.getElementById('consonants-count'),
    emptyState: document.getElementById('empty-state'),

    // 详情检查器 (Inspector)
    inspectorPanel: document.getElementById('inspector-panel'),
    inspectorIdle: document.getElementById('inspector-idle'),
    inspectorActive: document.getElementById('inspector-active'),
    inspectorAccentBadge: document.getElementById('inspector-accent-badge'),
    inspectorCategoryBadge: document.getElementById('inspector-category-badge'),
    inspectorSymbol: document.getElementById('inspector-symbol'),
    inspectorPulse: document.getElementById('inspector-pulse'),
    inspectorContrast: document.getElementById('inspector-symbol-contrast'),

    // 详情试听与重播按钮
    inspectorPlayUk: document.getElementById('inspector-play-uk'),
    inspectorPlayUkLabel: document.getElementById('inspector-play-uk-label'),
    inspectorPlayUs: document.getElementById('inspector-play-us'),
    inspectorPlayUsLabel: document.getElementById('inspector-play-us-label'),
    replayBtn: document.getElementById('replay-btn'),
    replayBtnLabel: document.getElementById('replay-btn-label'),

    // 播放状态条与缺失提示
    playbackStatusBar: document.getElementById('playback-status-bar'),
    statusText: document.getElementById('status-text'),
    inspectorNotice: document.getElementById('inspector-notice'),
    inspectorNoticeText: document.getElementById('inspector-notice-text'),

    // 例词、口型提示与卡片说明
    inspectorExample: document.getElementById('inspector-example'),
    inspectorWordRowUk: document.getElementById('inspector-word-row-uk'),
    inspectorWordRowUs: document.getElementById('inspector-word-row-us'),
    inspectorWordIpaUk: document.getElementById('inspector-word-ipa-uk'),
    inspectorWordIpaUs: document.getElementById('inspector-word-ipa-us'),
    inspectorWordBtn: document.getElementById('inspector-word-btn'),
    inspectorWordAccent: document.getElementById('inspector-word-accent'),
    inspectorWordKind: document.getElementById('inspector-word-kind'),
    inspectorWordBtnUs: document.getElementById('inspector-word-btn-us'),
    inspectorWordAccentUs: document.getElementById('inspector-word-accent-us'),
    inspectorWordKindUs: document.getElementById('inspector-word-kind-us'),
    inspectorExampleDictDetails: document.getElementById('inspector-example-dict-details'),
    inspectorExampleDictBody: document.getElementById('inspector-example-dict-body'),
    inspectorHint: document.getElementById('inspector-hint'),
    inspectorNoteSection: document.getElementById('inspector-note-section'),
    inspectorNote: document.getElementById('inspector-note'),

    // 其他常见写法折叠框
    inspectorAliasesDetails: document.getElementById('inspector-aliases-details'),
    inspectorAliasesBody: document.getElementById('inspector-aliases-body'),

    // 轻提示
    toastContainer: document.getElementById('toast-container'),

    // 发音解剖示意区
    inspectorArticulationSection: document.getElementById('inspector-articulation-section'),
    artTitle: document.getElementById('art-title'),
    artVoicingBadge: document.getElementById('art-voicing-badge'),
    artModeTag: document.getElementById('art-mode-tag'),
    artSummary: document.getElementById('art-summary'),
    artFramesContainer: document.getElementById('art-frames-container'),
    artAirflowBox: document.getElementById('art-airflow-box'),
    artAirflowText: document.getElementById('art-airflow-text'),
    artContrastBox: document.getElementById('art-contrast-box'),
    artContrastText: document.getElementById('art-contrast-text'),
    artContrastWords: document.getElementById('art-contrast-words'),
    artLipHint: document.getElementById('art-lip-hint'),
    artNote: document.getElementById('art-note'),
    artSourcesDetails: document.getElementById('art-sources-details'),
    artSourcesList: document.getElementById('art-sources-list'),

    // 发音放大预览原生 dialog 弹窗
    dialog: document.getElementById('articulation-dialog'),
    dialogCloseBtn: document.getElementById('dialog-close-btn'),
    dialogTitle: document.getElementById('dialog-title'),
    dialogBadge: document.getElementById('dialog-badge'),
    dialogImage: document.getElementById('dialog-image'),
    dialogFallback: document.getElementById('dialog-fallback'),
    dialogFrameLabel: document.getElementById('dialog-frame-label'),
    dialogFrameDesc: document.getElementById('dialog-frame-desc')
  };

  /**
   * 格式化国际音标字符（统一去除多余斜杠并包裹 / /）
   */
  function cleanSymbol(symbol) {
    if (!symbol) return '';
    return symbol.replace(/^\/|\/$/g, '').trim();
  }

  function formatSlashSymbol(symbol) {
    const cleaned = cleanSymbol(symbol);
    return cleaned ? `/${cleaned}/` : '—';
  }

  /**
   * 格式化整词IPA（统一包裹 / /）
   */
  function formatWordIPA(ipa) {
    if (!ipa) return '—';
    const cleaned = String(ipa).replace(/^\/|\/$/g, '').trim();
    return cleaned ? `/${cleaned}/` : '—';
  }

  /**
   * 获取音标卡片数据（仅读取 window.PHONEME_CARDS）
   */
  function getPhonemeCards() {
    if (Array.isArray(window.PHONEME_CARDS) && window.PHONEME_CARDS.length > 0) {
      return window.PHONEME_CARDS;
    }
    return [];
  }

  /**
   * 轻提示 Toast（用于状态更新、播放异常）
   */
  function showToast(message, type = 'info') {
    if (!elements.toastContainer) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', 'alert');

    const iconSpan = document.createElement('span');
    iconSpan.className = 'toast-icon';
    iconSpan.textContent = type === 'error' ? '⚠️' : 'ℹ️';

    const msgSpan = document.createElement('span');
    msgSpan.className = 'toast-msg';
    msgSpan.textContent = message;

    toast.appendChild(iconSpan);
    toast.appendChild(msgSpan);
    elements.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.transition = 'opacity 0.28s ease, transform 0.28s ease';
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      setTimeout(() => {
        if (toast.parentNode) {
          toast.parentNode.removeChild(toast);
        }
      }, 300);
    }, 3800);
  }

  /**
   * 设置详情栏播放状态信息
   * @param {'idle' | 'loading' | 'playing' | 'error'} status
   * @param {string} text
   */
  function setPlaybackStatus(status, text) {
    if (!elements.playbackStatusBar || !elements.statusText) return;

    elements.playbackStatusBar.classList.remove('playing', 'error');
    if (status === 'playing') {
      elements.playbackStatusBar.classList.add('playing');
    } else if (status === 'error') {
      elements.playbackStatusBar.classList.add('error');
    }
    elements.statusText.textContent = text || '就绪';
  }

  /**
   * 获取例词音频描述对象（无缝桥接主 agent 提供的 getWordAudio 与 window.WORD_RECORDINGS）
   */
  function getWordAudioInfo(word, accent) {
    if (typeof window.getWordAudio === 'function') {
      const res = window.getWordAudio(word, accent);
      if (res) return res;
    }
    const clean = typeof word === 'string' ? word.trim().toLowerCase() : '';
    if (!clean) return null;
    const recording = window.WORD_RECORDINGS?.[accent]?.[clean];
    if (recording && recording.audio) {
      return {
        id: `word-${accent}-${clean}`,
        word: clean,
        accent,
        audio: recording.audio,
        ipa: recording.ipa || '',
        sourceIPA: recording.sourceIPA || '',
        sourceUrl: recording.sourceUrl || '',
        source: recording.source || '',
        kind: 'recording',
        label: '真人'
      };
    }
    return {
      id: `word-${accent}-${clean}`,
      word: clean,
      accent,
      audio: null,
      ipa: recording?.ipa || '',
      sourceIPA: recording?.sourceIPA || '',
      sourceUrl: recording?.sourceUrl || '',
      source: recording?.source || '',
      kind: 'unavailable',
      label: '待补'
    };
  }

  /**
   * 更新各处音标播放按钮的外观态（加载中/播放中/就绪）
   */
  function updatePlayButtonsVisualState() {
    const isPlaying = !!state.activePlayingVariantId;
    const isLoading = !!state.loadingVariantId;
    const currentId = state.activePlayingVariantId || state.loadingVariantId;

    // 更新详情面板内的重播按钮
    if (elements.replayBtn && elements.replayBtnLabel) {
      if (isPlaying) {
        elements.replayBtn.classList.add('is-playing');
        elements.replayBtnLabel.textContent = '播放中...';
      } else if (isLoading) {
        elements.replayBtn.classList.remove('is-playing');
        elements.replayBtnLabel.textContent = '加载中...';
      } else {
        elements.replayBtn.classList.remove('is-playing');
        elements.replayBtnLabel.textContent = '重播发音';
      }
    }

    // 更新详情面板内的英音试听按钮
    if (elements.inspectorPlayUk) {
      const isUkActive = state.selectedCard?.variants?.uk?.id === currentId;
      elements.inspectorPlayUk.classList.toggle('is-playing', isUkActive && isPlaying);
    }

    // 更新详情面板内的美音试听按钮
    if (elements.inspectorPlayUs) {
      const isUsActive = state.selectedCard?.variants?.us?.id === currentId;
      elements.inspectorPlayUs.classList.toggle('is-playing', isUsActive && isPlaying);
    }
  }

  /**
   * 更新所有单词小喇叭按钮的视觉态（加载/播放/空闲）以及详情对照行
   */
  function updateWordButtonsVisualState() {
    const activeKey = state.activePlayingWordKey;
    const loadingKey = state.loadingWordKey;

    document.querySelectorAll('.word-play-btn').forEach(btn => {
      const w = btn.getAttribute('data-word')?.toLowerCase();
      const a = btn.getAttribute('data-accent');
      if (!w || !a) return;
      const key = `${w}-${a}`;

      const isPlaying = activeKey === key;
      const isLoading = loadingKey === key;

      btn.classList.toggle('is-playing', isPlaying);
      btn.classList.toggle('is-loading', isLoading);
    });

    if (elements.inspectorWordRowUk) {
      const isUkActive = !!activeKey && activeKey.endsWith('-uk');
      elements.inspectorWordRowUk.classList.toggle('is-playing', isUkActive);
    }
    if (elements.inspectorWordRowUs) {
      const isUsActive = !!activeKey && activeKey.endsWith('-us');
      elements.inspectorWordRowUs.classList.toggle('is-playing', isUsActive);
    }
  }

  /**
   * 为页面卡片和按钮应用发音中高亮
   */
  function applyPlayingHighlights(variantId) {
    removePlayingHighlights();

    // 高亮包含该变体的卡片
    document.querySelectorAll(`.phoneme-card[data-card-id]`).forEach((cardEl) => {
      const cardId = cardEl.getAttribute('data-card-id');
      const card = getPhonemeCards().find(c => c.id === cardId);
      if (card && (card.variants?.uk?.id === variantId || card.variants?.us?.id === variantId)) {
        cardEl.classList.add('playing');
      }
    });

    // 高亮特定卡片内的音频按钮
    document.querySelectorAll(`.card-play-btn[data-variant-id="${variantId}"]`).forEach((btn) => {
      btn.classList.add('is-playing');
    });

    // 详情大符号脉冲
    if (elements.inspectorSymbol) {
      elements.inspectorSymbol.classList.add('playing-scale');
    }

    updatePlayButtonsVisualState();
  }

  /**
   * 清除所有卡片和按钮的发音高亮
   */
  function removePlayingHighlights() {
    document.querySelectorAll('.phoneme-card.playing').forEach(el => el.classList.remove('playing'));
    document.querySelectorAll('.phoneme-card.loading').forEach(el => el.classList.remove('loading'));
    document.querySelectorAll('.card-play-btn.is-playing').forEach(el => el.classList.remove('is-playing'));
    if (elements.inspectorSymbol) {
      elements.inspectorSymbol.classList.remove('playing-scale');
    }
    updatePlayButtonsVisualState();
  }

  /**
   * 播放指定音标变体示范音频
   * 单通道：由 audio.js 内置单通道调度，必须真实等待 Promise 结束才 resolve
   * 保留版本号消除竞态
   */
  function playVariantAudio(variant, card, accent) {
    if (!variant) return;

    if (!variant.audio) {
      const reason = variant.unavailableReason || '当前音标暂无录音示范。';
      setPlaybackStatus('idle', reason);
      showToast(reason, 'info');
      return;
    }

    if (typeof window.playPhoneme !== 'function') {
      const errMsg = '音频播放器未加载，请刷新页面重试。';
      setPlaybackStatus('error', errMsg);
      showToast(errMsg, 'error');
      return;
    }

    // 取消正在播放的单词状态与高亮
    state.wordPlaybackVersion++;
    state.loadingWordKey = null;
    state.activePlayingWordKey = null;
    updateWordButtonsVisualState();

    const version = ++playbackVersion;
    state.loadingVariantId = variant.id;
    state.activePlayingVariantId = null;

    // 先清除已有卡片高亮并标记当前卡片正在加载
    document.querySelectorAll('.phoneme-card.playing').forEach(el => el.classList.remove('playing'));
    const targetCardEl = document.querySelector(`.phoneme-card[data-card-id="${card?.id}"]`);
    if (targetCardEl) {
      targetCardEl.classList.add('loading');
    }

    setPlaybackStatus('loading', `正在加载 ${formatSlashSymbol(variant.symbol)} 示范录音...`);
    updatePlayButtonsVisualState();

    let playPromise;
    try {
      playPromise = window.playPhoneme(variant);
    } catch (syncErr) {
      playPromise = Promise.reject(syncErr);
    }

    Promise.resolve(playPromise)
      .then(() => {
        if (version !== playbackVersion) return;
        setPlaybackStatus('idle', `发音完成 · ${formatSlashSymbol(variant.symbol)}`);
      })
      .catch((err) => {
        if (version !== playbackVersion || err?.name === 'AbortError') return;
        const msg = (err && (err.message || err.toString())) || '音频无法读取';
        setPlaybackStatus('error', `播放失败：${msg}`);
        showToast(`音标 [${formatSlashSymbol(variant.symbol)}] 播放失败: ${msg}`, 'error');
      })
      .finally(() => {
        if (version !== playbackVersion) return;
        state.loadingVariantId = null;
        state.activePlayingVariantId = null;
        if (targetCardEl) {
          targetCardEl.classList.remove('loading');
        }
        removePlayingHighlights();
      });
  }

  /**
   * 独立播放例词或对比例词发音
   * 共用 window.stopPhoneme()，防竞态与状态追踪
   */
  function playWordAudio(word, accent) {
    const cleanWord = typeof word === 'string' ? word.trim().toLowerCase() : '';
    if (!cleanWord) return;

    const info = getWordAudioInfo(cleanWord, accent);
    if (!info) {
      const msg = '未提供有效例词或口音。';
      setPlaybackStatus('error', msg);
      showToast(msg, 'info');
      return;
    }

    // 缺真人不合成替代，明确disable待补
    if (info.kind === 'unavailable' || (!info.audio && info.kind !== 'synthetic' && info.kind !== 'recording')) {
      const msg = `例词 "${cleanWord}" 暂无${accent === 'uk' ? '英音' : '美音'}真人示范录音。`;
      setPlaybackStatus('idle', msg);
      showToast(msg, 'info');
      return;
    }

    if (typeof window.playWord !== 'function') {
      const errMsg = '单词发音播放器未加载，请刷新页面重试。';
      setPlaybackStatus('error', errMsg);
      showToast(errMsg, 'error');
      return;
    }

    // 1. 停播现有音标或单词，共用 stopPhoneme
    if (typeof window.stopPhoneme === 'function') {
      window.stopPhoneme();
    }

    // 2. 作废旧音标加载/发音态
    playbackVersion++;
    state.loadingVariantId = null;
    state.activePlayingVariantId = null;
    removePlayingHighlights();

    // 3. 记录单词播放版本与状态
    const version = ++state.wordPlaybackVersion;
    const wordKey = `${info.word}-${accent}`;
    state.loadingWordKey = wordKey;
    state.activePlayingWordKey = null;
    updateWordButtonsVisualState();

    const sourceDesc = info.kind === 'recording' ? '真人录音' : '示范发音';
    setPlaybackStatus('loading', `正在加载例词 "${info.word}" (${accent.toUpperCase()} · ${sourceDesc})...`);

    let playPromise;
    try {
      playPromise = window.playWord(info.word, accent);
    } catch (syncErr) {
      playPromise = Promise.reject(syncErr);
    }

    Promise.resolve(playPromise)
      .then(() => {
        if (version !== state.wordPlaybackVersion) return;
        setPlaybackStatus('idle', `例词 "${info.word}" (${accent.toUpperCase()}) 播放完成`);
      })
      .catch((err) => {
        if (version !== state.wordPlaybackVersion || err?.name === 'AbortError') return;
        const msg = (err && (err.message || err.toString())) || '单词音频无法读取';
        setPlaybackStatus('error', `例词播放失败：${msg}`);
        showToast(`例词 [${info.word}] 播放失败: ${msg}`, 'error');
      })
      .finally(() => {
        if (version !== state.wordPlaybackVersion) return;
        state.loadingWordKey = null;
        state.activePlayingWordKey = null;
        updateWordButtonsVisualState();
      });
  }

  // 记录放大弹窗打开前的聚焦元素，用于无障碍焦点返回
  let lastDialogTrigger = null;
  let activeArt = null;
  let artFrameIndex = 0;
  let artTimer = null;

  function updateArtControls() {
    for (const id of ['art-step-controls', 'dialog-frame-controls']) {
      const controls = document.getElementById(id);
      if (!controls) continue;
      controls.querySelectorAll('button').forEach(button => {
        if (button.dataset.frame !== undefined) {
          button.setAttribute('aria-pressed', String(Number(button.dataset.frame) === artFrameIndex));
        } else {
          button.textContent = artTimer !== null ? '⏸ 暂停' : activeArt?.mode === 'sequence' ? '▶ 播放动作' : '▶ 轮播对照';
          button.setAttribute('aria-pressed', String(artTimer !== null));
        }
      });
    }
  }

  function pauseArtAnimation() {
    if (artTimer !== null) clearInterval(artTimer);
    artTimer = null;
    updateArtControls();
  }

  function selectArtFrame(index) {
    if (!activeArt?.frames.length) return;
    artFrameIndex = (index + activeArt.frames.length) % activeArt.frames.length;
    elements.artFramesContainer?.querySelectorAll('.art-frame-card').forEach((item, i) => item.classList.toggle('is-current-step', i === artFrameIndex));
    if (elements.dialog?.open) paintDialogFrame(activeArt.frames[artFrameIndex], activeArt.title, activeArt.voicing);
    updateArtControls();
  }

  function buildArtControls(controls) {
    if (!controls) return;
    controls.innerHTML = '';
    controls.hidden = !activeArt || activeArt.frames.length < 2;
    if (controls.hidden) return;
    activeArt.frames.forEach((frame, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.frame = String(index);
      button.textContent = frame.label;
      button.addEventListener('click', () => {pauseArtAnimation(); selectArtFrame(index);});
      controls.appendChild(button);
    });
    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'art-animation-toggle';
    play.addEventListener('click', () => {
      if (artTimer !== null) {pauseArtAnimation(); return;}
      artTimer = setInterval(() => selectArtFrame(artFrameIndex + 1), 1200);
      updateArtControls();
    });
    controls.appendChild(play);
    updateArtControls();
  }

  window.addEventListener('pagehide', pauseArtAnimation);
  window.addEventListener('art:pause', pauseArtAnimation);
  document.addEventListener('visibilitychange', () => {if (document.hidden) pauseArtAnimation();});

  /**
   * 打开示意图放大预览弹窗 (原生 dialog 或等效弹窗)
   */
  function paintDialogFrame(frame, title, voicing) {
    if (!elements.dialog) return;


    if (elements.dialogTitle) {
      elements.dialogTitle.textContent = title ? `${title} · 示意放大` : '发音示意放大预览';
    }
    if (elements.dialogBadge) {
      elements.dialogBadge.textContent = voicing || '声带振动';
      elements.dialogBadge.classList.toggle('is-unvoiced', voicing === '声带不振动');
    }
    if (elements.dialogFrameLabel) {
      elements.dialogFrameLabel.textContent = frame.label || '';
    }
    if (elements.dialogFrameDesc) {
      elements.dialogFrameDesc.textContent = frame.alt || '';
    }

    if (elements.dialogImage) {
      elements.dialogImage.style.display = 'block';
      if (elements.dialogFallback) elements.dialogFallback.hidden = true;

      elements.dialogImage.onerror = () => {
        elements.dialogImage.style.display = 'none';
        if (elements.dialogFallback) elements.dialogFallback.hidden = false;
      };

      elements.dialogImage.src = `${frame.asset}?v=human-glides-9`;
      elements.dialogImage.alt = frame.alt || frame.label;
    }

  }

  function openDialog(frame, title, voicing) {
    if (!elements.dialog) return;
    pauseArtAnimation();
    lastDialogTrigger = document.activeElement;
    const index = activeArt?.frames.indexOf(frame);
    if (index >= 0) selectArtFrame(index);
    paintDialogFrame(frame, title, voicing);
    buildArtControls(document.getElementById('dialog-frame-controls'));
    if (typeof elements.dialog.showModal === 'function') {
      try {
        elements.dialog.showModal();
      } catch (_) {
        elements.dialog.setAttribute('open', '');
      }
    } else if (typeof elements.dialog.setAttribute === 'function') {
      elements.dialog.setAttribute('open', '');
    }

    if (elements.dialogCloseBtn && typeof elements.dialogCloseBtn.focus === 'function') {
      elements.dialogCloseBtn.focus();
    }
  }

  /**
   * 关闭示意图放大预览弹窗并返回焦点
   */
  function closeDialog() {
    pauseArtAnimation();
    if (!elements.dialog) return;

    const isOpen = elements.dialog.open || (typeof elements.dialog.hasAttribute === 'function' && elements.dialog.hasAttribute('open'));
    if (!isOpen) return;

    if (typeof elements.dialog.close === 'function') {
      try {
        elements.dialog.close();
      } catch (_) {
        elements.dialog.removeAttribute('open');
      }
    } else if (typeof elements.dialog.removeAttribute === 'function') {
      elements.dialog.removeAttribute('open');
    }

    if (lastDialogTrigger && typeof lastDialogTrigger.focus === 'function') {
      try {
        lastDialogTrigger.focus();
      } catch (_) {}
      lastDialogTrigger = null;
    }
  }

  /**
   * 渲染发音示意预览区 (当前card+accent变化同步刷新，未覆盖卡片隐藏整个区避免残留)
   */
  function renderArticulation(card, accent) {
    pauseArtAnimation();
    activeArt = null;
    artFrameIndex = 0;
    const pairButton = document.getElementById('paired-sound-btn');
    if (pairButton) pairButton.hidden = true;
    const stepControls = document.getElementById('art-step-controls');
    if (stepControls) {stepControls.hidden = true; stepControls.innerHTML = '';}
    if (!elements.inspectorArticulationSection) return;

    if (!card || typeof window.getArticulation !== 'function') {
      elements.inspectorArticulationSection.hidden = true;
      if (elements.artFramesContainer) elements.artFramesContainer.innerHTML = '';
      if (elements.artAirflowBox) elements.artAirflowBox.hidden = true;
      if (elements.artContrastBox) elements.artContrastBox.hidden = true;
      if (elements.artContrastWords) elements.artContrastWords.hidden = true;
      return;
    }

    const art = window.getArticulation(card, accent);
    if (!art) {
      elements.inspectorArticulationSection.hidden = true;
      if (elements.artFramesContainer) elements.artFramesContainer.innerHTML = '';
      if (elements.artAirflowBox) elements.artAirflowBox.hidden = true;
      if (elements.artContrastBox) elements.artContrastBox.hidden = true;
      if (elements.artContrastWords) elements.artContrastWords.hidden = true;
      return;
    }

    activeArt = art;
    elements.inspectorArticulationSection.hidden = false;
    if (pairButton && art.pairedSymbol) {
      const pairCard = getPhonemeCards().find(item => item.variants?.[accent]?.symbol === art.pairedSymbol);
      if (pairCard) {
        pairButton.hidden = false;
        pairButton.textContent = `对照 /${art.pairedSymbol}/ →`;
        pairButton.onclick = () => selectCard(pairCard, accent, false);
      }
    }

    if (elements.artTitle) {
      elements.artTitle.textContent = art.title || card.example || '发音解剖示意';
    }

    if (elements.artVoicingBadge) {
      elements.artVoicingBadge.textContent = art.voicing || '声带振动';
      elements.artVoicingBadge.classList.toggle('is-unvoiced', art.voicing === '声带不振动');
    }

    if (elements.artModeTag) {
      if (art.mode === 'alternatives') {
        elements.artModeTag.hidden = false;
        elements.artModeTag.textContent = '两图为可选方式 · 非先后步骤';
      } else if (art.mode === 'sequence') {
        elements.artModeTag.hidden = false;
        elements.artModeTag.textContent = art.sequenceLabel || '两阶段连续动作 · 示意';
      } else if (art.mode === 'views') {
        elements.artModeTag.hidden = false;
        elements.artModeTag.textContent = '同一发音 · 两个视角';
      } else {
        elements.artModeTag.hidden = true;
      }
    }

    if (elements.artSummary) {
      elements.artSummary.textContent = art.summary || '';
    }

    if (elements.artLipHint) {
      elements.artLipHint.textContent = art.lipHint || '自然放松。';
    }

    if (elements.artNote) {
      const specificNote = (art.note || '').replace(/^动作草图，待语音专业审核：.*?未完整展示鼻腔、喉部和三维结构。\s*/, '').trim();
      elements.artNote.textContent = specificNote;
      const noteBox = document.getElementById('art-note-box');
      if (noteBox) noteBox.hidden = !specificNote;
    }

    if (elements.artFramesContainer) {
      elements.artFramesContainer.innerHTML = '';
      elements.artFramesContainer.dataset.stepped = String(art.frames.length > 1);
      if (Array.isArray(art.frames) && art.frames.length > 0) {
        art.frames.forEach((f, idx) => {
          if (idx > 0) {
            if (art.mode === 'sequence') {
              const arrow = document.createElement('div');
              arrow.className = 'art-sequence-arrow';
              arrow.setAttribute('aria-hidden', 'true');
              arrow.textContent = '➔';
              elements.artFramesContainer.appendChild(arrow);
            } else if (art.mode === 'alternatives') {
              const divider = document.createElement('div');
              divider.className = 'art-alt-divider';
              divider.setAttribute('aria-hidden', 'true');
              divider.textContent = '或';
              elements.artFramesContainer.appendChild(divider);
            } else if (art.mode === 'views') {
              const divider = document.createElement('div');
              divider.className = 'art-views-divider';
              divider.setAttribute('aria-hidden', 'true');
              divider.textContent = '另一视角';
              elements.artFramesContainer.appendChild(divider);
            }
          }

          const frameBtn = document.createElement('button');
          frameBtn.type = 'button';
          frameBtn.className = 'art-frame-card' + (idx === 0 ? ' is-current-step' : '');
          frameBtn.setAttribute('aria-label', `点击放大：${f.label}。${f.alt || ''}`);
          frameBtn.title = `点击放大：${f.label}`;

          const imgWrap = document.createElement('div');
          imgWrap.className = 'art-frame-img-wrap';

          const img = document.createElement('img');
          img.className = 'art-frame-img';
          img.src = `${f.asset}?v=human-glides-9`;
          img.alt = f.alt || f.label;
          img.loading = 'lazy';

          const fallback = document.createElement('div');
          fallback.className = 'art-frame-fallback';
          fallback.hidden = true;
          fallback.innerHTML = '<span class="fallback-icon" aria-hidden="true">⚠️</span><span>示意图缺失</span>';

          img.onerror = () => {
            img.style.display = 'none';
            fallback.hidden = false;
          };

          const zoomBadge = document.createElement('span');
          zoomBadge.className = 'art-zoom-badge';
          zoomBadge.setAttribute('aria-hidden', 'true');
          zoomBadge.textContent = '🔍 放大';

          imgWrap.appendChild(img);
          imgWrap.appendChild(fallback);
          imgWrap.appendChild(zoomBadge);

          const label = document.createElement('span');
          label.className = 'art-frame-label';
          label.textContent = f.label;

          frameBtn.appendChild(imgWrap);
          frameBtn.appendChild(label);

          frameBtn.addEventListener('click', () => {
            openDialog(f, art.title, art.voicing);
          });

          elements.artFramesContainer.appendChild(frameBtn);
        });
        buildArtControls(stepControls);
      }
    }

    if (elements.artAirflowBox && elements.artAirflowText) {
      const airflow = (art.airflow || '').trim();
      if (airflow) {
        elements.artAirflowText.textContent = airflow;
        elements.artAirflowBox.hidden = false;
      } else {
        elements.artAirflowBox.hidden = true;
        elements.artAirflowText.textContent = '';
      }
    }

    if (elements.artContrastBox && elements.artContrastText) {
      const contrast = (art.contrast || '').trim();
      if (contrast) {
        elements.artContrastText.textContent = contrast;
        elements.artContrastBox.hidden = false;
      } else {
        elements.artContrastBox.hidden = true;
        elements.artContrastText.textContent = '';
      }
    }

    // 渲染对比词独立小喇叭按钮列表 (使用 profile.exampleWords，严格不从中文提取)
    if (elements.artContrastWords) {
      elements.artContrastWords.innerHTML = '';
      const exampleWords = Array.isArray(art.exampleWords) ? art.exampleWords : [];
      if (exampleWords.length > 0) {
        elements.artContrastWords.hidden = false;

        const wordAccent = accent || state.defaultAccent;
        const title = document.createElement('div');
        title.className = 'contrast-words-title';
        title.textContent = `对比例词独立试听 (${wordAccent.toUpperCase()})：`;
        elements.artContrastWords.appendChild(title);

        const list = document.createElement('div');
        list.className = 'contrast-words-list';

        exampleWords.forEach((word) => {
          const info = getWordAudioInfo(word, wordAccent);
          const isRec = info?.kind === 'recording' && !!info?.audio;
          const kindText = isRec ? '真人' : '待补';

          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = `word-play-btn contrast-word-btn ${isRec ? '' : 'is-unavailable'}`;
          btn.setAttribute('data-word', word);
          btn.setAttribute('data-accent', wordAccent);
          btn.setAttribute('aria-label', `试听对比例词 ${word} (${wordAccent.toUpperCase()} · ${kindText})`);
          btn.title = isRec ? `试听对比例词 ${word} (${wordAccent.toUpperCase()} · 真人)` : `${word} (${wordAccent.toUpperCase()} 真人示范待补)`;
          if (!isRec) btn.disabled = true;

          const wordSpan = document.createElement('span');
          wordSpan.className = 'word-text';
          wordSpan.textContent = word;

          const ipaSpan = document.createElement('span');
          ipaSpan.className = 'contrast-word-ipa ipa-font';
          ipaSpan.textContent = formatWordIPA(info?.ipa);

          const spkIcon = document.createElement('span');
          spkIcon.className = 'word-speaker-icon';
          spkIcon.setAttribute('aria-hidden', 'true');
          spkIcon.textContent = '🔊';

          const accTag = document.createElement('span');
          accTag.className = 'word-accent-tag';
          accTag.textContent = wordAccent.toUpperCase();

          const kindTag = document.createElement('span');
          kindTag.className = `word-kind-tag ${isRec ? 'kind-recording' : 'kind-unavailable'}`;
          kindTag.textContent = kindText;

          btn.appendChild(wordSpan);
          btn.appendChild(ipaSpan);
          btn.appendChild(spkIcon);
          btn.appendChild(accTag);
          btn.appendChild(kindTag);

          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            playWordAudio(word, wordAccent);
          });

          btn.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.stopPropagation();
            }
          });

          list.appendChild(btn);
        });

        elements.artContrastWords.appendChild(list);
      } else {
        elements.artContrastWords.hidden = true;
      }
    }

    if (elements.artSourcesDetails && elements.artSourcesList) {
      elements.artSourcesList.innerHTML = '';
      if (Array.isArray(art.sources) && art.sources.length > 0) {
        elements.artSourcesDetails.hidden = false;
        elements.artSourcesDetails.open = false;
        art.sources.forEach(src => {
          if (!src || !src.url) return;
          const li = document.createElement('li');
          const a = document.createElement('a');
          a.href = src.url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = src.title || src.url;
          li.appendChild(a);
          elements.artSourcesList.appendChild(li);
        });
      } else {
        elements.artSourcesDetails.hidden = true;
      }
    }
  }

  /**
   * 刷新详情面板内容
   * @param {Object} card 选中的卡片
   * @param {'uk'|'us'} accent 聚焦的口音
   */
  function updateInspector(card, accent = state.defaultAccent) {
    if (!card) {
      if (elements.inspectorIdle) elements.inspectorIdle.hidden = false;
      if (elements.inspectorActive) elements.inspectorActive.hidden = true;
      renderArticulation(null, accent);
      return;
    }

    if (elements.inspectorIdle) elements.inspectorIdle.hidden = true;
    if (elements.inspectorActive) elements.inspectorActive.hidden = false;

    state.inspectorAccent = accent;

    const uk = card.variants?.uk;
    const us = card.variants?.us;
    const currentVariant = accent === 'us' ? us : uk;
    const otherVariant = accent === 'us' ? uk : us;
    const isUk = accent === 'uk';

    // 顶部标记
    if (elements.inspectorAccentBadge) {
      elements.inspectorAccentBadge.textContent = isUk ? '🇬🇧 英音 (UK)' : '🇺🇸 美音 (US)';
    }

    if (elements.inspectorCategoryBadge) {
      elements.inspectorCategoryBadge.textContent = CATEGORY_NAMES[card.category] || '音标';
    }

    // 大符号：展示当前聚焦口音符号，若该口音缺失则降级展示另一口音或占位
    const displaySymbol = currentVariant?.symbol || otherVariant?.symbol || card.example || '—';
    if (elements.inspectorSymbol) {
      elements.inspectorSymbol.textContent = formatSlashSymbol(displaySymbol);
    }

    // 符号差异对照条 (展示真实差异并列)
    if (elements.inspectorContrast) {
      const ukSym = cleanSymbol(uk?.symbol);
      const usSym = cleanSymbol(us?.symbol);

      if (ukSym && usSym && ukSym === usSym) {
        elements.inspectorContrast.hidden = false;
        elements.inspectorContrast.innerHTML = `英美共用记音：<strong class="ipa-font">/${ukSym}/</strong>`;
      } else if (ukSym && usSym && ukSym !== usSym) {
        elements.inspectorContrast.hidden = false;
        elements.inspectorContrast.innerHTML = `记音对照：英 <strong class="ipa-font">/${ukSym}/</strong> · 美 <strong class="ipa-font">/${usSym}/</strong>`;
      } else if (ukSym && !usSym) {
        elements.inspectorContrast.hidden = false;
        elements.inspectorContrast.innerHTML = `英音记作 <strong class="ipa-font">/${ukSym}/</strong>（美音无独立对应）`;
      } else if (!ukSym && usSym) {
        elements.inspectorContrast.hidden = false;
        elements.inspectorContrast.innerHTML = `美音记作 <strong class="ipa-font">/${usSym}/</strong>（英音无独立对应）`;
      } else {
        elements.inspectorContrast.hidden = true;
      }
    }

    // 双音试听按钮状态配置
    if (elements.inspectorPlayUk) {
      const hasUkAudio = !!uk?.audio;
      elements.inspectorPlayUk.disabled = !hasUkAudio;
      elements.inspectorPlayUk.classList.toggle('is-active', isUk);
      const ukReason = uk?.unavailableReason || (uk ? '暂无英音音频' : '无对应英音变体');
      elements.inspectorPlayUk.title = hasUkAudio ? `试听英音 ${formatSlashSymbol(uk?.symbol)}` : ukReason;
      if (elements.inspectorPlayUkLabel) {
        elements.inspectorPlayUkLabel.textContent = hasUkAudio ? `试听英音 ${formatSlashSymbol(uk?.symbol)}` : '英音(暂无音频)';
      }
    }

    if (elements.inspectorPlayUs) {
      const hasUsAudio = !!us?.audio;
      elements.inspectorPlayUs.disabled = !us;
      elements.inspectorPlayUs.setAttribute('aria-label', hasUsAudio ? '试听美音示范' : '查看美音详情（独立示范待补）');
      elements.inspectorPlayUs.classList.toggle('is-active', !isUk);
      if (hasUsAudio) {
        elements.inspectorPlayUs.title = `试听美音 ${formatSlashSymbol(us?.symbol)}`;
        if (elements.inspectorPlayUsLabel) {
          elements.inspectorPlayUsLabel.textContent = `试听美音 ${formatSlashSymbol(us?.symbol)}`;
        }
      } else {
        elements.inspectorPlayUs.title = '美音独立示范待补（可通过下方例词小喇叭试听整词发音）';
        if (elements.inspectorPlayUsLabel) {
          elements.inspectorPlayUsLabel.textContent = '查看美音 · 示范待补';
        }
      }
    }

    // 变体说明 / 缺失原因提示
    if (elements.inspectorNotice && elements.inspectorNoticeText) {
      const reason = currentVariant?.unavailableReason || (!currentVariant?.audio ? otherVariant?.unavailableReason : null);
      if (reason) {
        elements.inspectorNotice.hidden = false;
        elements.inspectorNoticeText.textContent = reason;
      } else {
        elements.inspectorNotice.hidden = true;
      }
    }

    // 经典例词与真人整词发音（英美双行对比对照，免切顶栏直接试听）
    if (elements.inspectorExample) {
      elements.inspectorExample.textContent = card.example || '—';
    }

    const cleanEx = typeof card.example === 'string' ? card.example.trim().toLowerCase() : '';
    if (cleanEx && cleanEx !== '—') {
      const ukInfo = getWordAudioInfo(cleanEx, 'uk');
      const usInfo = getWordAudioInfo(cleanEx, 'us');

      // 更新 UK 行
      if (elements.inspectorWordIpaUk) {
        elements.inspectorWordIpaUk.textContent = formatWordIPA(ukInfo?.ipa);
      }
      if (elements.inspectorWordBtn) {
        elements.inspectorWordBtn.hidden = false;
        elements.inspectorWordBtn.setAttribute('data-word', cleanEx);
        elements.inspectorWordBtn.setAttribute('data-accent', 'uk');
        const ukIsRec = ukInfo?.kind === 'recording' && !!ukInfo?.audio;
        elements.inspectorWordBtn.disabled = !ukIsRec;
        elements.inspectorWordBtn.classList.toggle('is-unavailable', !ukIsRec);
        elements.inspectorWordBtn.setAttribute('aria-label', `试听例词 ${cleanEx} (UK · ${ukIsRec ? '真人' : '待补'})`);
        elements.inspectorWordBtn.title = ukIsRec ? `试听例词 ${cleanEx} (UK · 真人)` : `${cleanEx} (UK 真人示范待补)`;
        if (elements.inspectorWordAccent) elements.inspectorWordAccent.textContent = 'UK';
        if (elements.inspectorWordKind) {
          elements.inspectorWordKind.className = `word-kind-tag ${ukIsRec ? 'kind-recording' : 'kind-unavailable'}`;
          elements.inspectorWordKind.textContent = ukIsRec ? '真人' : '待补';
        }
      }

      // 更新 US 行
      if (elements.inspectorWordIpaUs) {
        elements.inspectorWordIpaUs.textContent = formatWordIPA(usInfo?.ipa);
      }
      if (elements.inspectorWordBtnUs) {
        elements.inspectorWordBtnUs.hidden = false;
        elements.inspectorWordBtnUs.setAttribute('data-word', cleanEx);
        elements.inspectorWordBtnUs.setAttribute('data-accent', 'us');
        const usIsRec = usInfo?.kind === 'recording' && !!usInfo?.audio;
        elements.inspectorWordBtnUs.disabled = !usIsRec;
        elements.inspectorWordBtnUs.classList.toggle('is-unavailable', !usIsRec);
        elements.inspectorWordBtnUs.setAttribute('aria-label', `试听例词 ${cleanEx} (US · ${usIsRec ? '真人' : '待补'})`);
        elements.inspectorWordBtnUs.title = usIsRec ? `试听例词 ${cleanEx} (US · 真人)` : `${cleanEx} (US 真人示范待补)`;
        if (elements.inspectorWordAccentUs) elements.inspectorWordAccentUs.textContent = 'US';
        if (elements.inspectorWordKindUs) {
          elements.inspectorWordKindUs.className = `word-kind-tag ${usIsRec ? 'kind-recording' : 'kind-unavailable'}`;
          elements.inspectorWordKindUs.textContent = usIsRec ? '真人' : '待补';
        }
      }

      // 标记当前详情面板聚焦口音行
      if (elements.inspectorWordRowUk) {
        elements.inspectorWordRowUk.classList.toggle('is-current', accent === 'uk');
      }
      if (elements.inspectorWordRowUs) {
        elements.inspectorWordRowUs.classList.toggle('is-current', accent === 'us');
      }

      // 词典折叠来源展示
      if (elements.inspectorExampleDictDetails && elements.inspectorExampleDictBody) {
        const links = [];
        if (ukInfo?.sourceUrl) links.push({label: `英音词条 (${ukInfo.source || 'Oxford'})`, url: ukInfo.sourceUrl, ipa: ukInfo.sourceIPA || ukInfo.ipa});
        if (usInfo?.sourceUrl && usInfo.sourceUrl !== ukInfo?.sourceUrl) links.push({label: `美音词条 (${usInfo.source || 'Oxford'})`, url: usInfo.sourceUrl, ipa: usInfo.sourceIPA || usInfo.ipa});
        if (links.length > 0) {
          elements.inspectorExampleDictDetails.hidden = false;
          elements.inspectorExampleDictBody.innerHTML = links.map(l => `<div><strong>${l.label}</strong>：<a href="${l.url}" target="_blank" rel="noopener noreferrer">${l.url}</a> ${l.ipa ? `[${l.ipa}]` : ''}</div>`).join('');
        } else {
          elements.inspectorExampleDictDetails.hidden = true;
          elements.inspectorExampleDictBody.innerHTML = '';
        }
      }
    } else {
      if (elements.inspectorWordBtn) elements.inspectorWordBtn.hidden = true;
      if (elements.inspectorWordBtnUs) elements.inspectorWordBtnUs.hidden = true;
      if (elements.inspectorWordIpaUk) elements.inspectorWordIpaUk.textContent = '—';
      if (elements.inspectorWordIpaUs) elements.inspectorWordIpaUs.textContent = '—';
      if (elements.inspectorExampleDictDetails) elements.inspectorExampleDictDetails.hidden = true;
    }

    // 发音解剖示意区 (在 hint 前刷新)
    renderArticulation(card, accent);

    // 发音口型秘诀
    if (elements.inspectorHint) {
      elements.inspectorHint.textContent = currentVariant?.hint || otherVariant?.hint || '暂无发音秘诀。';
    }

    // 卡片体系说明 (card.note)
    if (elements.inspectorNoteSection && elements.inspectorNote) {
      if (card.note) {
        elements.inspectorNoteSection.hidden = false;
        elements.inspectorNote.textContent = card.note;
      } else {
        elements.inspectorNoteSection.hidden = true;
      }
    }

    // 其他常见写法折叠框（默认折叠，列出可用 variants 的 aliases）
    if (elements.inspectorAliasesDetails && elements.inspectorAliasesBody) {
      elements.inspectorAliasesDetails.open = false;
      elements.inspectorAliasesBody.innerHTML = '';

      const ukAliases = Array.isArray(uk?.aliases) ? uk.aliases : [];
      const usAliases = Array.isArray(us?.aliases) ? us.aliases : [];

      if (ukAliases.length === 0 && usAliases.length === 0) {
        elements.inspectorAliasesBody.innerHTML = '<p class="aliases-empty">暂无其他替代写法。</p>';
      } else {
        if (ukAliases.length > 0) {
          const row = document.createElement('div');
          row.className = 'alias-row';
          const label = document.createElement('span');
          label.className = 'alias-label';
          label.textContent = '英音常见写法：';
          row.appendChild(label);
          ukAliases.forEach(alias => {
            const chip = document.createElement('span');
            chip.className = 'alias-chip';
            chip.textContent = formatSlashSymbol(alias);
            row.appendChild(chip);
          });
          elements.inspectorAliasesBody.appendChild(row);
        }

        if (usAliases.length > 0) {
          const row = document.createElement('div');
          row.className = 'alias-row';
          const label = document.createElement('span');
          label.className = 'alias-label';
          label.textContent = '美音常见写法：';
          row.appendChild(label);
          usAliases.forEach(alias => {
            const chip = document.createElement('span');
            chip.className = 'alias-chip';
            chip.textContent = formatSlashSymbol(alias);
            row.appendChild(chip);
          });
          elements.inspectorAliasesBody.appendChild(row);
        }
      }
    }

    setPlaybackStatus('idle', '已就绪，可随时试听或重播');
  }

  /**
   * 刷新所有卡片上的例词整词IPA与小喇叭口音标签与音源类型
   */
  function updateAllCardWordDisplays() {
    document.querySelectorAll('.phoneme-card[data-card-id]').forEach(cardEl => {
      const cardId = cardEl.getAttribute('data-card-id');
      const card = getPhonemeCards().find(c => c.id === cardId);
      if (!card || !card.example) return;

      const currentAccent = state.defaultAccent;
      const info = getWordAudioInfo(card.example, currentAccent);
      const isRec = info?.kind === 'recording' && !!info?.audio;
      const kindText = isRec ? '真人' : '待补';

      const ipaSpan = cardEl.querySelector('.card-word-ipa');
      if (ipaSpan) {
        ipaSpan.textContent = formatWordIPA(info?.ipa);
      }

      const wordBtn = cardEl.querySelector('.card-word-btn');
      if (!wordBtn) return;

      wordBtn.setAttribute('data-accent', currentAccent);
      wordBtn.setAttribute('aria-label', `试听例词 ${card.example} (${currentAccent.toUpperCase()} · ${kindText})`);
      wordBtn.title = isRec ? `试听例词 ${card.example} (${currentAccent.toUpperCase()} · 真人)` : `${card.example} (${currentAccent.toUpperCase()} 暂无真人示范)`;

      if (isRec) {
        wordBtn.disabled = false;
        wordBtn.classList.remove('is-unavailable');
      } else {
        wordBtn.disabled = true;
        wordBtn.classList.add('is-unavailable');
      }

      const accentTag = wordBtn.querySelector('.word-accent-tag');
      if (accentTag) {
        accentTag.textContent = currentAccent.toUpperCase();
      }

      const kindTag = wordBtn.querySelector('.word-kind-tag');
      if (kindTag) {
        kindTag.className = `word-kind-tag ${isRec ? 'kind-recording' : 'kind-unavailable'}`;
        kindTag.textContent = kindText;
      }
    });
  }

  /**
   * 选中音标卡片
   * @param {Object} card
   * @param {'uk'|'us'} [targetAccent] 触发口音，缺省时使用当前默认口音
   * @param {boolean} [shouldPlay] 是否尝试播放
   */
  function selectCard(card, targetAccent, shouldPlay = false) {
    if (!card) return;

    const accent = targetAccent || state.defaultAccent;
    state.selectedCardId = card.id;
    state.selectedCard = card;

    // 更新各卡片选中样式
    document.querySelectorAll('.phoneme-card').forEach((cardEl) => {
      const isCurrent = cardEl.getAttribute('data-card-id') === card.id;
      cardEl.classList.toggle('selected', isCurrent);
      const mainBtn = cardEl.querySelector('.card-main-btn');
      if (mainBtn) {
        mainBtn.setAttribute('aria-pressed', isCurrent ? 'true' : 'false');
      }
    });

    // 选中卡片时（无论是否自动发音），停止先前可能正在播放的声音（包括例词）
    if (!shouldPlay) {
      playbackVersion++;
      state.wordPlaybackVersion++;
      if (typeof window.stopPhoneme === 'function') {
        window.stopPhoneme();
      }
      state.loadingVariantId = null;
      state.activePlayingVariantId = null;
      state.loadingWordKey = null;
      state.activePlayingWordKey = null;
      removePlayingHighlights();
      updateWordButtonsVisualState();
    } else {
      state.wordPlaybackVersion++;
      state.loadingWordKey = null;
      state.activePlayingWordKey = null;
      updateWordButtonsVisualState();
    }

    // 更新详情面板内容
    updateInspector(card, accent);
    window.MobileDetails?.show(card.id);

    if (shouldPlay) {
      const variant = card.variants ? card.variants[accent] : null;
      if (variant?.audio) {
        playVariantAudio(variant, card, accent);
      } else {
        // Invalidate completion callbacks before canceling an unavailable selection.
        playbackVersion++;
        if (typeof window.stopPhoneme === 'function') {
          window.stopPhoneme();
        }
        state.loadingVariantId = null;
        state.activePlayingVariantId = null;
        removePlayingHighlights();

        const reason = variant?.unavailableReason || `${accent === 'uk' ? '英音' : '美音'}暂无示范录音。`;
        setPlaybackStatus('idle', reason);
        showToast(reason, 'info');
      }
    }
  }

  /**
   * 重置当前选中状态
   */
  function resetSelection() {
    if (document.getElementById('mobile-detail-dialog')?.open && window.MobileDetails) {
      window.MobileDetails.dismiss();
      return;
    }
    playbackVersion++;
    state.wordPlaybackVersion++;
    if (typeof window.stopPhoneme === 'function') {
      window.stopPhoneme();
    }
    state.loadingVariantId = null;
    state.activePlayingVariantId = null;
    state.loadingWordKey = null;
    state.activePlayingWordKey = null;
    removePlayingHighlights();
    updateWordButtonsVisualState();

    state.selectedCardId = null;
    state.selectedCard = null;
    document.querySelectorAll('.phoneme-card.selected').forEach(c => {
      c.classList.remove('selected');
      const b = c.querySelector('.card-main-btn');
      if (b) b.setAttribute('aria-pressed', 'false');
    });
    updateInspector(null);
  }

  /**
   * 构造单个音标卡片 DOM
   * 严格遵守规则：
   * - 绝不嵌套 button！主选择按钮为原生 button，独立试听按钮为同级 button，例词小喇叭为独立按钮
   * - 符号相同只显示一次大字，不同显示 英 /x/ 美 /y/
   * - 没有音频的播放按钮 disabled 并显示原因（美音缺失3卡显示“示范待补”，绝不暗中改播另一口音）
   */
  function createCardElement(card) {
    const article = document.createElement('article');
    article.className = 'phoneme-card';
    article.setAttribute('data-card-id', card.id);
    article.setAttribute('data-category', card.category);

    const uk = card.variants?.uk;
    const us = card.variants?.us;
    const ukSym = cleanSymbol(uk?.symbol);
    const usSym = cleanSymbol(us?.symbol);
    const isSameSymbol = !!(ukSym && usSym && ukSym === usSym);

    // 1. 卡片顶部微标与例词（包含独立可访问例词小喇叭）
    const topRow = document.createElement('div');
    topRow.className = 'card-top-row';

    const dot = document.createElement('span');
    dot.className = `card-category-dot cat-${card.category}`;
    dot.setAttribute('aria-hidden', 'true');
    topRow.appendChild(dot);

    const exampleGroup = document.createElement('div');
    exampleGroup.className = 'card-example-group';

    const wordRow = document.createElement('div');
    wordRow.className = 'card-example-word-row';

    const exampleSpan = document.createElement('span');
    exampleSpan.className = 'card-example';
    exampleSpan.textContent = card.example || '';
    wordRow.appendChild(exampleSpan);

    // 独立整词IPA与小喇叭真人发音
    if (card.example) {
      const wordInfo = getWordAudioInfo(card.example, state.defaultAccent);
      const isRec = wordInfo?.kind === 'recording' && !!wordInfo?.audio;
      const kindText = isRec ? '真人' : '待补';

      const ipaSpan = document.createElement('span');
      ipaSpan.className = 'card-word-ipa ipa-font';
      ipaSpan.textContent = formatWordIPA(wordInfo?.ipa);
      wordRow.appendChild(ipaSpan);
      exampleGroup.appendChild(wordRow);

      const wordBtn = document.createElement('button');
      wordBtn.type = 'button';
      wordBtn.className = `word-play-btn card-word-btn ${isRec ? '' : 'is-unavailable'}`;
      wordBtn.setAttribute('data-word', card.example);
      wordBtn.setAttribute('data-accent', state.defaultAccent);
      wordBtn.setAttribute('aria-label', `试听例词 ${card.example} (${state.defaultAccent.toUpperCase()} · ${kindText})`);
      wordBtn.title = isRec ? `试听例词 ${card.example} (${state.defaultAccent.toUpperCase()} · 真人)` : `${card.example} (${state.defaultAccent.toUpperCase()} 暂无真人示范)`;
      if (!isRec) wordBtn.disabled = true;

      const spkIcon = document.createElement('span');
      spkIcon.className = 'word-speaker-icon';
      spkIcon.setAttribute('aria-hidden', 'true');
      spkIcon.textContent = '🔊';

      const accTag = document.createElement('span');
      accTag.className = 'word-accent-tag';
      accTag.textContent = state.defaultAccent.toUpperCase();

      const kindTag = document.createElement('span');
      kindTag.className = `word-kind-tag ${isRec ? 'kind-recording' : 'kind-unavailable'}`;
      kindTag.textContent = kindText;

      wordBtn.appendChild(spkIcon);
      wordBtn.appendChild(accTag);
      wordBtn.appendChild(kindTag);

      wordBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        playWordAudio(card.example, state.defaultAccent);
      });

      wordBtn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.stopPropagation();
        }
      });

      exampleGroup.appendChild(wordBtn);
    } else {
      exampleGroup.appendChild(wordRow);
    }

    topRow.appendChild(exampleGroup);
    article.appendChild(topRow);

    // 2. 卡片主选择区域 (原生 button，无嵌套)
    const mainBtn = document.createElement('button');
    mainBtn.type = 'button';
    mainBtn.className = 'card-main-btn';
    mainBtn.setAttribute('aria-pressed', 'false');

    const accessibilityLabel = isSameSymbol
      ? `音标 /${ukSym}/，例词 ${card.example || ''}`
      : `音标 英 /${ukSym || '—'}/ 美 /${usSym || '—'}/，例词 ${card.example || ''}`;
    mainBtn.setAttribute('aria-label', accessibilityLabel);

    // 符号显示区域
    const symbolWrap = document.createElement('div');
    symbolWrap.className = 'card-symbol-wrap';

    if (isSameSymbol) {
      const symbolSpan = document.createElement('span');
      symbolSpan.className = 'card-symbol ipa-font';
      symbolSpan.textContent = `/${ukSym}/`;
      symbolWrap.appendChild(symbolSpan);
    } else {
      const diffContainer = document.createElement('div');
      diffContainer.className = 'card-diff-symbols';

      if (ukSym) {
        const ukChip = document.createElement('span');
        ukChip.className = 'diff-chip diff-uk ipa-font';
        ukChip.innerHTML = `<span class="chip-label">英</span>/${ukSym}/`;
        diffContainer.appendChild(ukChip);
      }

      if (usSym) {
        const usChip = document.createElement('span');
        usChip.className = 'diff-chip diff-us ipa-font';
        usChip.innerHTML = `<span class="chip-label">美</span>/${usSym}/`;
        diffContainer.appendChild(usChip);
      }

      symbolWrap.appendChild(diffContainer);
    }

    mainBtn.appendChild(symbolWrap);
    article.appendChild(mainBtn);

    // 3. 独立音频试听按钮组 (与主按钮同级，绝不嵌套)
    const actionsRow = document.createElement('div');
    actionsRow.className = 'card-actions';
    actionsRow.setAttribute('role', 'group');
    actionsRow.setAttribute('aria-label', '发音试听');

    // 英音独立试听按钮
    const ukBtn = document.createElement('button');
    ukBtn.type = 'button';
    ukBtn.className = 'card-play-btn btn-uk';
    ukBtn.setAttribute('data-accent', 'uk');
    if (uk?.id) ukBtn.setAttribute('data-variant-id', uk.id);

    if (uk?.audio) {
      ukBtn.title = `试听英音 ${formatSlashSymbol(uk.symbol)}`;
      ukBtn.setAttribute('aria-label', `试听英音 ${formatSlashSymbol(uk.symbol)}`);
      ukBtn.innerHTML = `<span class="btn-flag" aria-hidden="true">🇬🇧</span><span class="btn-text">英</span>`;
    } else {
      ukBtn.disabled = true;
      const ukReason = uk?.unavailableReason || '英音暂无音频';
      ukBtn.title = ukReason;
      ukBtn.setAttribute('aria-label', `英音不可用：${ukReason}`);
      ukBtn.innerHTML = `<span class="btn-flag" aria-hidden="true">🇬🇧</span><span class="btn-text">示范待补</span>`;
    }

    // 美音独立试听按钮 (美音缺失3卡显示“示范待补”)
    const usBtn = document.createElement('button');
    usBtn.type = 'button';
    usBtn.className = 'card-play-btn btn-us';
    usBtn.setAttribute('data-accent', 'us');
    if (us?.id) usBtn.setAttribute('data-variant-id', us.id);

    if (us?.audio) {
      usBtn.title = `试听美音 ${formatSlashSymbol(us.symbol)}`;
      usBtn.setAttribute('aria-label', `试听美音 ${formatSlashSymbol(us.symbol)}`);
      usBtn.innerHTML = `<span class="btn-flag" aria-hidden="true">🇺🇸</span><span class="btn-text">美</span>`;
    } else {
      usBtn.disabled = true;
      usBtn.classList.add('is-pending');
      const usReason = us?.unavailableReason || '美音示范待补';
      usBtn.title = '美音独立示范待补（可通过上方例词小喇叭试听整词发音）';
      usBtn.setAttribute('aria-label', `美音示范待补：${usReason}`);
      usBtn.innerHTML = `<span class="btn-flag" aria-hidden="true">🇺🇸</span><span class="btn-text">示范待补</span>`;
    }

    actionsRow.appendChild(ukBtn);
    actionsRow.appendChild(usBtn);
    article.appendChild(actionsRow);

    // 4. 事件交互绑定
    // 顶部空白处点击也可选卡
    topRow.addEventListener('click', (e) => {
      if (e.target.closest('.card-word-btn')) return;
      selectCard(card, state.defaultAccent, true);
    });

    // 主区域点击：按顶栏默认口音播放
    mainBtn.addEventListener('click', () => {
      selectCard(card, state.defaultAccent, true);
    });

    // 英音独立按钮点击：选择卡片并播放英音
    ukBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      selectCard(card, 'uk', true);
    });

    // 美音独立按钮点击：选择卡片并播放美音
    usBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      selectCard(card, 'us', true);
    });

    return article;
  }

  /**
   * 渲染音标图表完整网格 (严格读取 window.PHONEME_CARDS)
   * 共45张卡，不称为“英语音素总数”
   */
  function renderChart() {
    const cards = getPhonemeCards();

    // 清空现有网格
    if (elements.gridShort) elements.gridShort.innerHTML = '';
    if (elements.gridLong) elements.gridLong.innerHTML = '';
    if (elements.gridDiphthong) elements.gridDiphthong.innerHTML = '';
    if (elements.gridRhotic) elements.gridRhotic.innerHTML = '';
    if (elements.gridConsonant) elements.gridConsonant.innerHTML = '';

    // 数据未加载时的防御
    if (cards.length === 0) {
      if (elements.emptyState) elements.emptyState.hidden = false;
      if (elements.vowelsCount) elements.vowelsCount.textContent = '共 0 张卡';
      if (elements.consonantsCount) elements.consonantsCount.textContent = '共 0 张卡';
      return;
    }

    if (elements.emptyState) {
      elements.emptyState.hidden = true;
    }

    let vowelCount = 0;
    let consonantCount = 0;

    cards.forEach((card) => {
      const cardEl = createCardElement(card);
      switch (card.category) {
        case 'short':
          if (elements.gridShort) elements.gridShort.appendChild(cardEl);
          vowelCount++;
          break;
        case 'long':
          if (elements.gridLong) elements.gridLong.appendChild(cardEl);
          vowelCount++;
          break;
        case 'diphthong':
          if (elements.gridDiphthong) elements.gridDiphthong.appendChild(cardEl);
          vowelCount++;
          break;
        case 'rhotic':
          if (elements.gridRhotic) elements.gridRhotic.appendChild(cardEl);
          vowelCount++;
          break;
        case 'consonant':
          if (elements.gridConsonant) elements.gridConsonant.appendChild(cardEl);
          consonantCount++;
          break;
        default:
          if (elements.gridConsonant) elements.gridConsonant.appendChild(cardEl);
          consonantCount++;
          break;
      }
    });

    // 更新分组卡片计数
    if (elements.vowelsCount) {
      elements.vowelsCount.textContent = `共 ${vowelCount} 张卡`;
    }
    if (elements.consonantsCount) {
      elements.consonantsCount.textContent = `共 ${consonantCount} 张卡`;
    }

    // 若此前已有选中卡片，恢复高亮及详情面板
    if (state.selectedCardId) {
      const current = cards.find(c => c.id === state.selectedCardId);
      if (current) {
        selectCard(current, state.inspectorAccent, false);
      }
    }
  }

  /**
   * 切换顶栏默认试听口音 (UK / US)
   * 规范要求：改变不替换整张表、停止当前播放、保留选中卡片并刷新详情，不要自动播放！
   */
  function switchDefaultAccent(newAccent) {
    if (state.defaultAccent === newAccent) return;

    // 1. 停止当前播放并立即重置加载状态
    playbackVersion++;
    state.wordPlaybackVersion++;
    if (typeof window.stopPhoneme === 'function') {
      window.stopPhoneme();
    }
    state.loadingVariantId = null;
    state.activePlayingVariantId = null;
    state.loadingWordKey = null;
    state.activePlayingWordKey = null;
    removePlayingHighlights();
    updateWordButtonsVisualState();

    // 2. 更新状态
    state.defaultAccent = newAccent;
    state.inspectorAccent = newAccent;

    // 3. 更新顶栏分段按钮
    if (elements.accentBtnUk && elements.accentBtnUs) {
      const isUk = newAccent === 'uk';
      elements.accentBtnUk.classList.toggle('active', isUk);
      elements.accentBtnUk.setAttribute('aria-checked', isUk ? 'true' : 'false');
      elements.accentBtnUs.classList.toggle('active', !isUk);
      elements.accentBtnUs.setAttribute('aria-checked', !isUk ? 'true' : 'false');
    }

    // 4. 更新全部卡片例词小喇叭口音标记与音源信息
    updateAllCardWordDisplays();

    // 5. 保留当前选中的卡片并刷新详情（不要重新替换整张表，不要自动播放）
    if (state.selectedCard) {
      updateInspector(state.selectedCard, newAccent);
    }

    showToast(`已将默认试听口音设为${newAccent === 'uk' ? '英音 (UK)' : '美音 (US)'}`, 'info');
  }

  /**
   * 重播当前选中的音标发音 (快捷键 R)
   */
  function replayCurrent() {
    if (!state.selectedCard) return;
    const accent = state.inspectorAccent || state.defaultAccent;
    const variant = state.selectedCard.variants ? state.selectedCard.variants[accent] : null;
    if (variant?.audio) {
      playVariantAudio(variant, state.selectedCard, accent);
    } else {
      const otherAccent = accent === 'uk' ? 'us' : 'uk';
      const otherVariant = state.selectedCard.variants ? state.selectedCard.variants[otherAccent] : null;
      const reason = variant?.unavailableReason || (otherVariant?.audio ? `当前为${accent === 'uk' ? '英音' : '美音'}，暂无录音（可点击试听另一口音）` : '暂无录音示范');
      showToast(reason, 'info');
    }
  }

  /**
   * 初始化全局事件监听
   */
  function setupEventListeners() {
    window.addEventListener('phoneme:detail-select', event => {
      const card = getPhonemeCards().find(item => item.id === event.detail?.id);
      if (card) selectCard(card, state.inspectorAccent, false);
    });
    window.addEventListener('phoneme:detail-dismiss', resetSelection);
    // 监听真实的音标启动事件：phoneme:playing
    window.addEventListener('phoneme:playing', (event) => {
      const playingId = event?.detail?.id;
      if (playingId && (state.loadingVariantId === playingId || state.activePlayingVariantId === playingId)) {
        state.activePlayingVariantId = playingId;
        state.loadingVariantId = null;
        applyPlayingHighlights(playingId);
        setPlaybackStatus('playing', '正在播放示范音频...');
      }
    });

    // 监听真实的单词启动事件：word:playing
    window.addEventListener('word:playing', (event) => {
      const detail = event?.detail;
      if (detail && detail.word && detail.accent) {
        const key = `${detail.word.toLowerCase()}-${detail.accent}`;
        if (state.loadingWordKey !== key && state.activePlayingWordKey !== key) return;
        state.activePlayingWordKey = key;
        state.loadingWordKey = null;
        updateWordButtonsVisualState();
        const sourceDesc = detail.kind === 'recording' ? '真人录音' : '合成发音';
        setPlaybackStatus('playing', `正在播放例词 "${detail.word}" (${detail.accent.toUpperCase()} · ${sourceDesc})...`);
      }
    });

    // 示意图放大弹窗关闭与点击背景监听
    if (elements.dialogCloseBtn) {
      elements.dialogCloseBtn.addEventListener('click', closeDialog);
    }
    if (elements.dialog) {
      elements.dialog.addEventListener('close', pauseArtAnimation);
      elements.dialog.addEventListener('cancel', (e) => {
        e.preventDefault();
        closeDialog();
      });
      elements.dialog.addEventListener('click', (e) => {
        if (e.target === elements.dialog) {
          closeDialog();
        }
      });
    }

    // 顶栏默认口音按钮点击
    if (elements.accentBtnUk) {
      elements.accentBtnUk.addEventListener('click', () => switchDefaultAccent('uk'));
    }
    if (elements.accentBtnUs) {
      elements.accentBtnUs.addEventListener('click', () => switchDefaultAccent('us'));
    }

    // 详情面板试听按钮点击
    if (elements.inspectorPlayUk) {
      elements.inspectorPlayUk.addEventListener('click', () => {
        if (state.selectedCard?.variants?.uk) {
          state.inspectorAccent = 'uk';
          updateInspector(state.selectedCard, 'uk');
          playVariantAudio(state.selectedCard.variants.uk, state.selectedCard, 'uk');
        }
      });
    }

    if (elements.inspectorPlayUs) {
      elements.inspectorPlayUs.addEventListener('click', () => {
        if (state.selectedCard?.variants?.us) {
          state.inspectorAccent = 'us';
          updateInspector(state.selectedCard, 'us');
          playVariantAudio(state.selectedCard.variants.us, state.selectedCard, 'us');
        }
      });
    }

    // 详情面板重播按钮点击
    if (elements.replayBtn) {
      elements.replayBtn.addEventListener('click', () => {
        replayCurrent();
      });
    }

    // 英美两行各自播放标注的口音，不受详情当前选中口音影响。
    for (const [button, accent] of [
      [elements.inspectorWordBtn, 'uk'],
      [elements.inspectorWordBtnUs, 'us']
    ]) {
      if (!button) continue;
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.selectedCard?.example) {
          playWordAudio(state.selectedCard.example, accent);
        }
      });

      button.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.stopPropagation();
        }
      });
    }

    // 全局键盘控制支持
    document.addEventListener('keydown', (e) => {
      if (document.getElementById('help-dialog')?.open) return;
      if (e.ctrlKey || e.metaKey || e.altKey || document.activeElement?.isContentEditable) return;
      const tag = document.activeElement ? document.activeElement.tagName : '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      // 若当前放大预览弹窗开启，Escape 仅关闭弹窗并返回焦点
      if (elements.dialog && (elements.dialog.open || (typeof elements.dialog.hasAttribute === 'function' && elements.dialog.hasAttribute('open')))) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          closeDialog();
        }
        return;
      }

      // 按键 R / r：重播当前选中音标
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        replayCurrent();
        return;
      }

      // 按键 1：设置默认试听为英音
      if (e.key === '1') {
        e.preventDefault();
        switchDefaultAccent('uk');
        return;
      }

      // 按键 2：设置默认试听为美音
      if (e.key === '2') {
        e.preventDefault();
        switchDefaultAccent('us');
        return;
      }

      // Escape：重置选中状态
      if (e.key === 'Escape') {
        if (document.getElementById('mobile-detail-dialog')?.open) return;
        resetSelection();
        return;
      }
    });

    // 支持主代理更新数据时的事件通信
    window.addEventListener('phonemes:updated', () => {
      renderChart();
    });
  }

  /**
   * 应用启动与数据检查
   */
  function init() {
    setupEventListeners();
    updateInspector(null);
    renderChart();

    // 若数据脚本稍后就绪，进行适度轮询探测
    if (!window.PHONEME_CARDS || !Array.isArray(window.PHONEME_CARDS) || window.PHONEME_CARDS.length === 0) {
      let retries = 0;
      const pollTimer = setInterval(() => {
        retries++;
        if (window.PHONEME_CARDS && Array.isArray(window.PHONEME_CARDS) && window.PHONEME_CARDS.length > 0) {
          clearInterval(pollTimer);
          renderChart();
        }
        if (retries > 25) {
          clearInterval(pollTimer);
        }
      }, 150);
    }
  }

  // DOM 就绪即启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
