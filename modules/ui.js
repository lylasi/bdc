import * as dom from './dom.js';
import { t } from './i18n.js';
import * as state from './state.js';

// =================================
// 通用 UI 組件
// =================================

/**
 * 轉義要放進 HTML 字串（innerHTML / 樣板字串）的動態文字。
 *
 * 站內的彈窗、清單、提示常常要插入「使用者可控」的內容——詞書名稱、單詞與釋義、
 * 問答集名稱、從網址／檔案匯入的資料、AI 與 OCR 的輸出。這些字串一旦直接串進
 * innerHTML，就會被當成標記解析，形成注入。
 *
 * 用法：所有要插進 HTML 的動態值都必須經過這個函式；
 * 能改用 textContent / createTextNode 的地方優先那樣做。
 */
export function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[ch]));
}

/** 轉義要放進 HTML 屬性值（尤其是被引號包住）的動態文字 */
export function escapeAttr(value) {
    return escapeHtml(value);
}

/**
 * 給「要放進 innerHTML 的翻譯字串」用的 t()：插值參數會先轉義。
 *
 * 問題模式：`el.innerHTML` 裡放 `t(key, { word: entry.word })`。
 * t() 只做字串替換、不轉義，於是任何被塞進 {word} 的外部資料
 * （詞書內容、匯入檔、AI/OCR 輸出）都能在頁面上解析成標記。
 *
 * 用法：參數是**純資料**時改用 tHtml；參數本身是 HTML 片段
 * （例如 {link} 帶一整段 <a>）時仍用 t()，並自行確保片段安全。
 */
export function tHtml(key, params = {}) {
    const safe = {};
    for (const [name, value] of Object.entries(params)) {
        // 數字／布林等非字串值不需要轉義，避免把 1e3 之類弄成字串比較
        safe[name] = (value === null || value === undefined) ? ''
            : (typeof value === 'object' ? escapeHtml(JSON.stringify(value)) : escapeHtml(value));
    }
    return t(key, safe);
}

// --- Modal (模態框) ---

/**
 * 打開主應用模態框。
 */
export function openModal() {
    dom.appModal.classList.remove('hidden');
}

/**
 * 關閉主應用模態框，並清空其內容。
 */
export function closeModal() {
    dom.appModal.classList.add('hidden');
    try { dom.appModal.querySelector('.modal-content')?.classList.remove('modal-large'); } catch (_) {}
    dom.modalBody.innerHTML = ''; // 清理內容以防下次打開時殘留
    // 固定底部列只有需要它的面板（例如全域設定）會填入內容；關閉時一併清掉，
    // 否則下一個面板會帶著上一個的按鈕。
    if (dom.modalActions) {
        dom.modalActions.hidden = true;
        dom.modalActions.innerHTML = '';
    }
    try { document.dispatchEvent(new CustomEvent('bdc:modal-closed')); } catch (_) {}
}

/**
 * 為模態框的關閉按鈕和背景點擊設置事件監聽。
 */
export function initModal() {
    dom.modalCloseBtn.addEventListener('click', closeModal);
    dom.appModal.addEventListener('click', (e) => {
        if (e.target === dom.appModal) {
            closeModal();
        }
    });
}


// --- Number Stepper (數字步進器) ---

/**
 * 為頁面中所有的數字步進器組件初始化事件監聽和功能。
 */
export function setupNumberSteppers() {
    const steppers = document.querySelectorAll('.number-stepper, .number-stepper-vertical');

    steppers.forEach(stepper => {
        const input = stepper.querySelector('.stepper-input');
        const minusBtn = stepper.querySelector('.stepper-minus, .stepper-down');
        const plusBtn = stepper.querySelector('.stepper-plus, .stepper-up');
        const slider = stepper.querySelector('.stepper-slider');

        if (!input || !minusBtn || !plusBtn) return;

        const parsedMin = parseInt(input.getAttribute('min') ?? '', 10);
        const parsedMax = parseInt(input.getAttribute('max') ?? '', 10);
        const min = Number.isNaN(parsedMin) ? Number.NEGATIVE_INFINITY : parsedMin;
        const max = Number.isNaN(parsedMax) ? Number.POSITIVE_INFINITY : parsedMax;

        if (slider) {
            const datasetMin = parseInt(stepper.dataset.sliderMin ?? '', 10);
            const datasetMax = parseInt(stepper.dataset.sliderMax ?? '', 10);

            if (!slider.hasAttribute('min')) {
                const sliderMin = !Number.isNaN(datasetMin) ? datasetMin : (Number.isFinite(min) ? min : 0);
                slider.setAttribute('min', sliderMin);
            }

            if (!slider.hasAttribute('max')) {
                if (!Number.isNaN(datasetMax)) {
                    slider.setAttribute('max', datasetMax);
                } else if (Number.isFinite(max)) {
                    slider.setAttribute('max', max);
                }
            }

            if (!slider.hasAttribute('step')) {
                slider.setAttribute('step', '1');
            }
        }

        const clampValue = (value) => {
            let numeric = parseInt(value, 10);
            if (Number.isNaN(numeric)) {
                numeric = Number.isFinite(min) ? min : 0;
            }

            if (numeric < min) numeric = min;
            if (numeric > max) numeric = max;

            return numeric;
        };

        const updateButtons = (value) => {
            minusBtn.disabled = Number.isFinite(min) && value <= min;
            plusBtn.disabled = Number.isFinite(max) && value >= max;
        };

        const syncSlider = (value) => {
            if (!slider) return;
            const sliderMax = parseInt(slider.getAttribute('max') ?? '', 10);
            if (!Number.isNaN(sliderMax) && value > sliderMax) {
                slider.setAttribute('max', value);
            }
            slider.value = value;
        };

        const commitValue = (value) => {
            const clamped = clampValue(value);
            input.value = clamped;
            updateButtons(clamped);
            syncSlider(clamped);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        };

        minusBtn.addEventListener('click', () => {
            commitValue(clampValue(input.value) - 1);
        });

        plusBtn.addEventListener('click', () => {
            commitValue(clampValue(input.value) + 1);
        });

        input.addEventListener('input', () => {
            const sanitized = clampValue(input.value);
            if (sanitized.toString() !== input.value.trim()) {
                input.value = sanitized;
            }
            updateButtons(sanitized);
            syncSlider(sanitized);
        });

        if (slider) {
            slider.addEventListener('input', () => {
                commitValue(slider.value);
            }, { passive: true });
        }

        const initialValue = clampValue(input.value);
        input.value = initialValue;
        updateButtons(initialValue);
        syncSlider(initialValue);
    });
}


// --- Tooltip (提示框) ---

/**
 * 重新定位單詞分析提示框，使其顯示在目標元素的上方或下方。
 * @param {HTMLElement} targetElement - 觸發提示框的目標元素。
 */
export function repositionTooltip(targetElement) {
    requestAnimationFrame(() => {
        const tooltip = dom.analysisTooltip;
        if (!tooltip) return;
        // 手機底部面板由 CSS 固定定位；這裡不再寫 top/left，否則 inline 樣式會蓋掉 bottom 定位。
        if (tooltip.classList.contains('tooltip-sheet')) {
            tooltip.style.visibility = 'visible';
            return;
        }
        const rect = targetElement.getBoundingClientRect();
        const tooltipHeight = tooltip.offsetHeight;
        const tooltipWidth = tooltip.offsetWidth;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth;

        // 先算「視窗座標」，再換算成 offsetParent 的定位座標。
        // 不能直接加 window.scrollY：平滑捲動進行中，rect 與 scrollY 可能不同步，
        // 會把詳解定位到離觸發詞很遠的地方（長詳解更容易看得出來）。
        let visualTop;
        if (rect.top > tooltipHeight + 10) {
            visualTop = rect.top - tooltipHeight - 5;
        } else {
            visualTop = rect.bottom + 5;
        }
        // 長詳解在橫屏／放大文字時可能比可視範圍還高：讓面板留在視窗內，內容再由
        // .tooltip 的 max-height／overflow 捲動。
        visualTop = Math.min(visualTop, viewportHeight - tooltipHeight - 10);
        visualTop = Math.max(10, visualTop);

        let visualLeft = rect.left;
        if (visualLeft + tooltipWidth > viewportWidth - 10) {
            visualLeft = rect.right - tooltipWidth;
        }
        if (visualLeft < 10) visualLeft = 10;

        const offsetParent = tooltip.offsetParent;
        if (offsetParent && offsetParent !== document.body && offsetParent !== document.documentElement) {
            const parentRect = offsetParent.getBoundingClientRect();
            tooltip.style.top = `${visualTop - parentRect.top - (offsetParent.clientTop || 0) + (offsetParent.scrollTop || 0)}px`;
            tooltip.style.left = `${visualLeft - parentRect.left - (offsetParent.clientLeft || 0) + (offsetParent.scrollLeft || 0)}px`;
        } else {
            const scrollY = window.scrollY || window.pageYOffset || 0;
            const scrollX = window.scrollX || window.pageXOffset || 0;
            tooltip.style.top = `${visualTop + scrollY}px`;
            tooltip.style.left = `${visualLeft + scrollX}px`;
        }
        tooltip.style.visibility = 'visible';
    });
}

/**
 * 收起單詞詳解。Escape、關閉鈕與外部點擊共用；
 * 會通知 article 模組清掉查詞 session 與焦點狀態。
 * @param {string} source - 關閉來源（escape／close-button／outside-click…）。
 */
export function hideTooltip(source = 'external') {
    const tooltip = dom.analysisTooltip;
    if (!tooltip) return;
    if (source === 'outside-click' && tooltip.dataset.keepOpen === 'word-ai') return;
    const wasVisible = tooltip.style.display !== 'none' && tooltip.style.display !== '';
    tooltip.style.display = 'none';
    tooltip.style.visibility = '';
    tooltip.classList.remove('tooltip-sheet');
    tooltip.classList.remove('word-ai-open');
    delete tooltip.dataset.keepOpen;
    if (wasVisible) {
        try {
            document.dispatchEvent(new CustomEvent('bdc:tooltip-hidden', { detail: { source } }));
        } catch (_) { /* noop */ }
    }
}

/**
 * 初始化全局點擊事件，用於隱藏提示框。
 */
export function initTooltip() {
    document.addEventListener('click', () => hideTooltip('outside-click'));
}

/**
 * 創建一個通用的單詞本選擇器（單選按鈕組）。
 * @param {HTMLElement} container - 用於放置選擇器的容器元素。
 * @param {string} defaultBookId - 默認選中的單詞本ID。
 */
export function createBookSelector(container, defaultBookId) {
    container.innerHTML = '';
    const bookCount = state.vocabularyBooks.length;

    if (bookCount === 0) {
        container.innerHTML = `<p data-i18n="common.noBooks">${t('common.noBooks')}</p>`;
        return;
    }

    const name = `${container.id.split('-')[0]}-book`;

    state.vocabularyBooks.forEach(book => {
        const wrapper = document.createElement('div');
        wrapper.className = 'radio-item-wrapper';
        
        const radioId = `${name}-radio-${book.id}`;
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.id = radioId;
        radio.name = name;
        radio.value = book.id;
        radio.className = 'radio-btn';
        if (book.id === defaultBookId) {
            radio.checked = true;
        }

        const label = document.createElement('label');
        label.htmlFor = radioId;
        label.textContent = book.name;
        label.className = 'radio-label';

        wrapper.appendChild(radio);
        wrapper.appendChild(label);
        container.appendChild(wrapper);
    });

    if (!container.querySelector('input:checked')) {
        const firstRadio = container.querySelector('input[type="radio"]');
        if(firstRadio) firstRadio.checked = true;
    }
}

// =================================
// 消息提示系統
// =================================

/**
 * 顯示消息提示
 * @param {string} message - 消息內容
 * @param {string} type - 消息類型: success, error, warning, info
 * @param {number} duration - 顯示時長(毫秒)，默認3000
 */
export function displayMessage(message, type = 'info', duration = 3000) {
    // 創建消息容器（如果不存在）
    let messageContainer = document.getElementById('message-container');
    if (!messageContainer) {
        messageContainer = document.createElement('div');
        messageContainer.id = 'message-container';
        document.body.appendChild(messageContainer);
    }

    // 創建消息元素（樣式集中在 styles.css 的 .message-toast）
    const messageElement = document.createElement('div');
    messageElement.className = `message-toast message-${type}`;
    messageElement.setAttribute('role', type === 'error' ? 'alert' : 'status');
    const textEl = document.createElement('span');
    textEl.className = 'message-toast__text';
    textEl.textContent = message;
    messageElement.appendChild(textEl);

    // 提示條本體不吃點擊（pointer-events: none），只有這顆關閉鈕可點。
    // 先前整條都可點，等於在畫面底部中央放了一塊 440×N 的點擊攔截區：
    // 文章「朗读控制」那一列、聽寫設定列正好在同一條基線上，提示顯示期間就點不到，
    // 加上滑鼠移入會暫停自動消失，使用者會被卡住。
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'message-toast__close';
    closeBtn.setAttribute('aria-label', t('common.dismiss'));
    closeBtn.textContent = '×';
    messageElement.appendChild(closeBtn);

    messageContainer.appendChild(messageElement);

    // 進場動畫
    requestAnimationFrame(() => messageElement.classList.add('is-shown'));

    const dismiss = () => {
        if (messageElement.dataset.closing) return;
        messageElement.dataset.closing = '1';
        clearTimeout(hideTimer);
        messageElement.classList.remove('is-shown');
        setTimeout(() => messageElement.remove(), 220);
    };

    // 自動移除
    let hideTimer = setTimeout(dismiss, duration);

    closeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        dismiss();
    });
    // 點整條也能關（只有本體可點時才需要；現在本體不吃事件，保留給鍵盤焦點情境）
    messageElement.addEventListener('click', dismiss);
}

// =================================
// 選項彈窗系統
// =================================

/**
 * 通用確認對話框（沿用選項彈窗樣式，取代原生 confirm）。
 * @param {{title?: string, message?: string, confirmLabel?: string, cancelLabel?: string, danger?: boolean}} config
 * @returns {Promise<boolean>} 使用者是否按下確認
 */
export function confirmAction(config = {}) {
  const { title = '', message = '', confirmLabel = '', cancelLabel = '', danger = false } = config;

  return new Promise((resolve) => {
    const overlay = showOptionsModal({
      title,
      description: message,
      options: [],
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false)
    });

    const confirmBtn = overlay.querySelector('#confirm-btn');
    if (confirmBtn) {
      if (confirmLabel) confirmBtn.textContent = confirmLabel;
      // 破壞性操作（刪除等）用紅色確認鈕
      if (danger) confirmBtn.classList.add('btn-danger');
    }
    if (cancelLabel) {
      const cancelBtn = overlay.querySelector('#cancel-btn');
      if (cancelBtn) cancelBtn.textContent = cancelLabel;
    }
  });
}

/**
 * 單行文字輸入彈窗（沿用站內彈窗外殼，取代原生 prompt）。
 * @returns {Promise<string|null>} 取消時回傳 null
 */
export function promptAction(config = {}) {
  const {
    title = '',
    message = '',
    label = '',
    value = '',
    placeholder = '',
    confirmLabel = '',
    cancelLabel = ''
  } = config;

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay options-modal-overlay';
    overlay.innerHTML = `
      <div class="modal-content options-modal-content prompt-modal">
        <div class="modal-header">
          <h3>${escapeHtml(title || t('common.optionsTitle'))}</h3>
          ${message ? `<p class="om-desc">${escapeHtml(message)}</p>` : ''}
        </div>
        <div class="modal-body">
          ${label ? `<label class="prompt-label" for="prompt-input">${escapeHtml(label)}</label>` : ''}
          <input id="prompt-input" class="prompt-input" type="text" autocomplete="off"
            placeholder="${escapeAttr(placeholder)}" aria-label="${escapeAttr(label || title)}">
        </div>
        <div class="modal-footer modal-actions">
          <button id="prompt-cancel" class="btn-secondary" type="button">${escapeHtml(cancelLabel || t('common.cancel'))}</button>
          <button id="prompt-confirm" class="btn-primary" type="button">${escapeHtml(confirmLabel || t('common.confirm'))}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('#prompt-input');
    input.value = String(value || '');
    const cleanup = () => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
    };
    const submit = () => {
      const next = input.value;
      cleanup();
      resolve(next);
    };
    const cancel = () => {
      cleanup();
      resolve(null);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); cancel(); }
      else if (event.key === 'Enter') { event.preventDefault(); submit(); }
    };
    overlay.querySelector('#prompt-confirm').addEventListener('click', submit);
    overlay.querySelector('#prompt-cancel').addEventListener('click', cancel);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) cancel(); });
    document.addEventListener('keydown', onKey);
    setTimeout(() => { try { input.focus(); input.select(); } catch (_) {} }, 20);
  });
}

/**
 * 顯示選項彈窗
 * @param {Object} config - 彈窗配置
 * @param {string} config.title - 彈窗標題
 * @param {string} config.description - 彈窗描述
 * @param {Array} config.options - 選項數組
 * @param {Function} config.onConfirm - 確認回調
 * @param {Function} config.onCancel - 取消回調
 */
export function showOptionsModal(config) {
  const {
    title = '',
    description = '',
    options = [],
    onConfirm = () => {},
    onCancel = () => {}
  } = config;

  // 沿用全域彈窗外殼（.modal-overlay / .modal-content），樣式見 styles.css
  const modalOverlay = document.createElement('div');
  modalOverlay.className = 'modal-overlay options-modal-overlay';

  const modalContent = document.createElement('div');
  modalContent.className = 'modal-content options-modal-content';

  modalContent.innerHTML = `
    <div class="modal-header">
      <h3>${escapeHtml(title || t('common.optionsTitle'))}</h3>
      ${description ? `<p class="om-desc">${escapeHtml(description)}</p>` : ''}
    </div>

    <div class="modal-body">
      <div id="options-container" class="om-grid"></div>
    </div>

    <div class="modal-footer modal-actions">
      <button id="cancel-btn" class="btn-secondary cancel-btn">${escapeHtml(t('common.cancel'))}</button>
      <button id="confirm-btn" class="btn-primary save-btn">${escapeHtml(t('common.confirm'))}</button>
    </div>
  `;

  modalOverlay.appendChild(modalContent);

  // 渲染選項
  const optionsContainer = modalContent.querySelector('#options-container');
  renderOptions(optionsContainer, options);

  // 添加事件監聽
  const cancelBtn = modalContent.querySelector('#cancel-btn');
  const confirmBtn = modalContent.querySelector('#confirm-btn');

  const closeModal = () => {
    document.removeEventListener('keydown', handleEsc);
    if (modalOverlay.parentNode) modalOverlay.parentNode.removeChild(modalOverlay);
  };

  cancelBtn.addEventListener('click', () => {
    onCancel();
    closeModal();
  });

  confirmBtn.addEventListener('click', () => {
    const result = getOptionsResult(optionsContainer, options);
    onConfirm(result);
    closeModal();
  });

  // 點擊背景關閉
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) {
      onCancel();
      closeModal();
    }
  });

  // ESC鍵關閉
  function handleEsc(e) {
    if (e.key === 'Escape') {
      onCancel();
      closeModal();
    }
  }
  document.addEventListener('keydown', handleEsc);

  // 添加到頁面
  document.body.appendChild(modalOverlay);

  return modalOverlay;
}

// 渲染選項
function renderOptions(container, options) {
  container.innerHTML = '';

  options.forEach((option, index) => {
    const optionElement = document.createElement('div');
    optionElement.className = 'option-item';

    if (option.type === 'radio') {
      optionElement.innerHTML = createRadioOption(option, index);
    } else if (option.type === 'checkbox') {
      optionElement.innerHTML = createCheckboxOption(option, index);
    } else if (option.type === 'select') {
      optionElement.innerHTML = createSelectOption(option, index);
    } else if (option.type === 'number') {
      optionElement.innerHTML = createNumberOption(option, index);
    }

    container.appendChild(optionElement);
  });
}

// 創建單選選項
function createRadioOption(option, index) {
  const radioOptions = option.choices.map((choice) => `
    <label class="radio-card">
      <input type="radio" name="option-${index}" value="${escapeAttr(choice.value)}" ${choice.value === option.default ? 'checked' : ''}>
      <div>
        <div class="om-option-title">${escapeHtml(choice.label)}</div>
        ${choice.description ? `<div class="om-option-desc">${escapeHtml(choice.description)}</div>` : ''}
      </div>
    </label>
  `).join('');

  return `
    <div class="om-field">
      <h4 class="om-label">${escapeHtml(option.label)}</h4>
      ${option.description ? `<p class="om-hint">${escapeHtml(option.description)}</p>` : ''}
    </div>
    <div class="radio-group" data-option-key="${escapeAttr(option.key)}">
      ${radioOptions}
    </div>
  `;
}

// 創建復選框選項
function createCheckboxOption(option, index) {
  const id = `chk-${escapeAttr(option.key)}-${index}`;
  return `
    <div class="om-row">
      <div>
        <div class="om-option-title">${escapeHtml(option.label)}</div>
        ${option.description ? `<div class="om-option-desc">${escapeHtml(option.description)}</div>` : ''}
      </div>
      <label class="switch" for="${id}"><input id="${id}" type="checkbox" data-option-key="${escapeAttr(option.key)}" ${option.default ? 'checked' : ''}><span class="slider"></span></label>
    </div>
  `;
}

// 創建下拉選項
function createSelectOption(option, index) {
  const selectOptions = option.choices.map(choice => `
    <option value="${escapeAttr(choice.value)}" ${choice.value === option.default ? 'selected' : ''}>
      ${escapeHtml(choice.label)}
    </option>
  `).join('');

  return `
    <div class="om-field">
      <label class="om-label" for="sel-${escapeAttr(option.key)}-${index}">${escapeHtml(option.label)}</label>
      ${option.description ? `<p class="om-hint">${escapeHtml(option.description)}</p>` : ''}
      <select id="sel-${escapeAttr(option.key)}-${index}" data-option-key="${escapeAttr(option.key)}">
        ${selectOptions}
      </select>
    </div>
  `;
}

// 創建數字輸入選項
function createNumberOption(option, index) {
  return `
    <div class="om-field">
      <label class="om-label" for="num-${escapeAttr(option.key)}-${index}">${escapeHtml(option.label)}</label>
      ${option.description ? `<p class="om-hint">${escapeHtml(option.description)}</p>` : ''}
      <input
        id="num-${escapeAttr(option.key)}-${index}"
        type="number"
        data-option-key="${escapeAttr(option.key)}"
        value="${escapeAttr(option.default || option.min || 1)}"
        min="${escapeAttr(option.min || 1)}"
        max="${escapeAttr(option.max || 100)}"
      >
    </div>
  `;
}

// 獲取選項結果
function getOptionsResult(container, options) {
  const result = {};

  options.forEach(option => {
    const key = option.key;

    if (option.type === 'radio') {
      const radioGroup = container.querySelector(`.radio-group[data-option-key="${key}"]`);
      const checked = radioGroup.querySelector('input[type="radio"]:checked');
      result[key] = checked ? checked.value : option.default;
    } else if (option.type === 'checkbox') {
      const checkbox = container.querySelector(`input[type="checkbox"][data-option-key="${key}"]`);
      result[key] = checkbox ? checkbox.checked : option.default;
    } else if (option.type === 'select') {
      const select = container.querySelector(`select[data-option-key="${key}"]`);
      result[key] = select ? select.value : option.default;
    } else if (option.type === 'number') {
      const input = container.querySelector(`input[type="number"][data-option-key="${key}"]`);
      result[key] = input ? parseInt(input.value) : option.default;
    }
  });

  return result;
}
