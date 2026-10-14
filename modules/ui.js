import * as dom from './dom.js';
import { t } from './i18n.js';
import * as state from './state.js';

// =================================
// 通用 UI 組件
// =================================

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
        const rect = targetElement.getBoundingClientRect();
        const tooltipHeight = dom.analysisTooltip.offsetHeight;
        const tooltipWidth = dom.analysisTooltip.offsetWidth;
        const spaceAbove = rect.top;

        let top, left;

        // 優先顯示在上方
        if (spaceAbove > tooltipHeight + 10) {
            top = rect.top + window.scrollY - tooltipHeight - 5;
        } else { // 上方空間不足，顯示在下方
            top = rect.bottom + window.scrollY + 5;
        }

        // 確保不超出屏幕左右邊界
        left = rect.left;
        if (left + tooltipWidth > window.innerWidth - 10) {
            left = rect.right - tooltipWidth;
        }
        if (left < 10) {
            left = 10;
        }

        dom.analysisTooltip.style.top = `${top}px`;
        dom.analysisTooltip.style.left = `${left}px`;
        dom.analysisTooltip.style.visibility = 'visible';
    });
}

/**
 * 初始化全局點擊事件，用於隱藏提示框。
 */
export function initTooltip() {
    document.addEventListener('click', () => {
        dom.analysisTooltip.style.display = 'none';
    });
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
    messageElement.textContent = message;
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

    // 自動移除（滑鼠移入時暫停計時，方便閱讀較長的錯誤訊息）
    let hideTimer = setTimeout(dismiss, duration);
    messageElement.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    messageElement.addEventListener('mouseleave', () => { hideTimer = setTimeout(dismiss, 1200); });

    // 點擊移除
    messageElement.addEventListener('click', dismiss);
}

// =================================
// 選項彈窗系統
// =================================

/**
 * 通用確認對話框（沿用選項彈窗樣式，取代原生 confirm）。
 * @param {{title?: string, message?: string, confirmLabel?: string, cancelLabel?: string}} config
 * @returns {Promise<boolean>} 使用者是否按下確認
 */
export function confirmAction(config = {}) {
  const { title = '', message = '', confirmLabel = '', cancelLabel = '' } = config;

  return new Promise((resolve) => {
    const overlay = showOptionsModal({
      title,
      description: message,
      options: [],
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false)
    });

    if (confirmLabel) {
      const confirmBtn = overlay.querySelector('#confirm-btn');
      if (confirmBtn) confirmBtn.textContent = confirmLabel;
    }
    if (cancelLabel) {
      const cancelBtn = overlay.querySelector('#cancel-btn');
      if (cancelBtn) cancelBtn.textContent = cancelLabel;
    }
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
      <h3>${title || t('common.optionsTitle')}</h3>
      ${description ? `<p class="om-desc">${description}</p>` : ''}
    </div>

    <div class="modal-body">
      <div id="options-container" class="om-grid"></div>
    </div>

    <div class="modal-footer modal-actions">
      <button id="cancel-btn" class="btn-secondary cancel-btn">${t('common.cancel')}</button>
      <button id="confirm-btn" class="btn-primary save-btn">${t('common.confirm')}</button>
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
      <input type="radio" name="option-${index}" value="${choice.value}" ${choice.value === option.default ? 'checked' : ''}>
      <div>
        <div class="om-option-title">${choice.label}</div>
        ${choice.description ? `<div class="om-option-desc">${choice.description}</div>` : ''}
      </div>
    </label>
  `).join('');

  return `
    <div class="om-field">
      <h4 class="om-label">${option.label}</h4>
      ${option.description ? `<p class="om-hint">${option.description}</p>` : ''}
    </div>
    <div class="radio-group" data-option-key="${option.key}">
      ${radioOptions}
    </div>
  `;
}

// 創建復選框選項
function createCheckboxOption(option, index) {
  const id = `chk-${option.key}-${index}`;
  return `
    <div class="om-row">
      <div>
        <div class="om-option-title">${option.label}</div>
        ${option.description ? `<div class="om-option-desc">${option.description}</div>` : ''}
      </div>
      <label class="switch" for="${id}"><input id="${id}" type="checkbox" data-option-key="${option.key}" ${option.default ? 'checked' : ''}><span class="slider"></span></label>
    </div>
  `;
}

// 創建下拉選項
function createSelectOption(option, index) {
  const selectOptions = option.choices.map(choice => `
    <option value="${choice.value}" ${choice.value === option.default ? 'selected' : ''}>
      ${choice.label}
    </option>
  `).join('');

  return `
    <div class="om-field">
      <label class="om-label" for="sel-${option.key}-${index}">${option.label}</label>
      ${option.description ? `<p class="om-hint">${option.description}</p>` : ''}
      <select id="sel-${option.key}-${index}" data-option-key="${option.key}">
        ${selectOptions}
      </select>
    </div>
  `;
}

// 創建數字輸入選項
function createNumberOption(option, index) {
  return `
    <div class="om-field">
      <label class="om-label" for="num-${option.key}-${index}">${option.label}</label>
      ${option.description ? `<p class="om-hint">${option.description}</p>` : ''}
      <input
        id="num-${option.key}-${index}"
        type="number"
        data-option-key="${option.key}"
        value="${option.default || option.min || 1}"
        min="${option.min || 1}"
        max="${option.max || 100}"
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
