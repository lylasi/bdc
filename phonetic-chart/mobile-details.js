/* Mobile detail sheet: reuse the inspector DOM so audio controls have one owner. */
(() => {
  const byId = id => document.getElementById(id);
  const dialog = byId('mobile-detail-dialog');
  const panel = byId('inspector-panel');
  if (!dialog || !panel || !window.matchMedia) return;
  const media = window.matchMedia('(max-width: 900px)');
  const home = panel.parentNode;
  const anchor = document.createComment('desktop inspector position');
  home.insertBefore(anchor, panel);
  const body = byId('mobile-detail-body');
  const close = byId('mobile-detail-close');
  const previous = byId('mobile-detail-prev');
  const next = byId('mobile-detail-next');
  const listen = byId('mobile-mode-listen');
  const art = byId('mobile-mode-art');
  let selectedId = null;
  let trigger = null;
  let savedScroll = 0;
  let locked = false;
  let mode = 'listen';
  let savedStyle = '';

  function setMode(value) {
    window.dispatchEvent(new CustomEvent('art:pause'));
    mode = value === 'art' && !art.disabled ? 'art' : 'listen';
    panel.dataset.mobileMode = mode;
    listen.setAttribute('aria-pressed', String(mode === 'listen'));
    art.setAttribute('aria-pressed', String(mode === 'art'));
    body.scrollTop = 0;
  }

  function unlock() {
    if (!locked) return;
    locked = false;
    document.body.style.cssText = savedStyle;
    window.scrollTo(0, savedScroll);
    if (trigger?.isConnected) trigger.focus({preventScroll: true});
    trigger = null;
  }

  function dismiss() {
    if (!dialog.open) return;
    const zoom = byId('articulation-dialog');
    if (zoom?.open) zoom.close();
    dialog.close();
    unlock();
    window.dispatchEvent(new CustomEvent('phoneme:detail-dismiss'));
  }

  function show(id) {
    selectedId = id;
    if (!media.matches) return;
    const cards = window.PHONEME_CARDS || [];
    const index = cards.findIndex(card => card.id === id);
    previous.disabled = index <= 0;
    next.disabled = index < 0 || index >= cards.length - 1;
    byId('mobile-detail-position').textContent = `${index + 1} / ${cards.length}`;
    art.disabled = byId('inspector-articulation-section').hidden;
    art.textContent = art.disabled ? '发音图待补' : '发音图';
    if (!dialog.open) {
      trigger = document.querySelector('.phoneme-card.selected .card-main-btn') || document.activeElement;
      savedScroll = window.scrollY;
      savedStyle = document.body.style.cssText;
      document.body.style.position = 'fixed';
      document.body.style.top = `-${savedScroll}px`;
      document.body.style.width = '100%';
      document.body.style.overflow = 'hidden';
      locked = true;
      dialog.showModal();
      setMode('listen');
      close.focus({preventScroll: true});
    } else {
      setMode(mode);
    }
  }

  function navigate(step) {
    const cards = window.PHONEME_CARDS || [];
    const index = cards.findIndex(card => card.id === selectedId);
    const card = cards[index + step];
    if (index >= 0 && card) window.dispatchEvent(new CustomEvent('phoneme:detail-select', {detail: {id: card.id}}));
  }

  function syncLayout() {
    if (media.matches) {
      body.appendChild(panel);
    } else {
      if (dialog.open) dismiss();
      home.insertBefore(panel, anchor.nextSibling);
      delete panel.dataset.mobileMode;
    }
  }

  close.addEventListener('click', dismiss);
  dialog.addEventListener('cancel', event => {event.preventDefault(); dismiss();});
  dialog.addEventListener('close', () => {if (!dialog.open) unlock();});
  dialog.addEventListener('click', event => {if (event.target === dialog) dismiss();});
  previous.addEventListener('click', () => navigate(-1));
  next.addEventListener('click', () => navigate(1));
  listen.addEventListener('click', () => setMode('listen'));
  art.addEventListener('click', () => setMode('art'));
  media.addEventListener('change', syncLayout);
  syncLayout();
  window.MobileDetails = {show, dismiss};
})();
