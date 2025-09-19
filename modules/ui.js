import * as dom from './dom.js';
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
        container.innerHTML = '<p>沒有可用的單詞本。</p>';
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
        messageContainer.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 10000;
            pointer-events: none;
        `;
        document.body.appendChild(messageContainer);
    }

    // 創建消息元素
    const messageElement = document.createElement('div');
    messageElement.className = `message-toast message-${type}`;
    messageElement.textContent = message;

    // 設置樣式
    messageElement.style.cssText = `
        background: ${getMessageBgColor(type)};
        color: ${getMessageTextColor(type)};
        padding: 12px 16px;
        margin-bottom: 8px;
        border-radius: 6px;
        border-left: 4px solid ${getMessageBorderColor(type)};
        box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        pointer-events: auto;
        max-width: 320px;
        word-wrap: break-word;
        font-size: 14px;
        line-height: 1.4;
        transform: translateX(100%);
        transition: transform 0.3s ease;
    `;

    // 添加到容器
    messageContainer.appendChild(messageElement);

    // 動畫顯示
    setTimeout(() => {
        messageElement.style.transform = 'translateX(0)';
    }, 10);

    // 自動移除
    setTimeout(() => {
        messageElement.style.transform = 'translateX(100%)';
        setTimeout(() => {
            if (messageElement.parentNode) {
                messageElement.parentNode.removeChild(messageElement);
            }
        }, 300);
    }, duration);

    // 點擊移除
    messageElement.addEventListener('click', () => {
        messageElement.style.transform = 'translateX(100%)';
        setTimeout(() => {
            if (messageElement.parentNode) {
                messageElement.parentNode.removeChild(messageElement);
            }
        }, 300);
    });
}

/**
 * 獲取消息背景色
 */
function getMessageBgColor(type) {
    const colors = {
        success: '#f0f9ff',
        error: '#fef2f2',
        warning: '#fffbeb',
        info: '#f8fafc'
    };
    return colors[type] || colors.info;
}

/**
 * 獲取消息文字色
 */
function getMessageTextColor(type) {
    const colors = {
        success: '#166534',
        error: '#dc2626',
        warning: '#d97706',
        info: '#475569'
    };
    return colors[type] || colors.info;
}

/**
 * 獲取消息邊框色
 */
function getMessageBorderColor(type) {
    const colors = {
        success: '#22c55e',
        error: '#ef4444',
        warning: '#f59e0b',
        info: '#3b82f6'
    };
    return colors[type] || colors.info;
}

// =================================
// 選項彈窗系統
// =================================

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
    title = '選項設定',
    description = '',
    options = [],
    onConfirm = () => {},
    onCancel = () => {}
  } = config;

  // 創建彈窗容器
  const modalOverlay = document.createElement('div');
  modalOverlay.className = 'options-modal-overlay';
  modalOverlay.style.cssText = `
    position: fixed; inset: 0; width: 100%; height: 100%;
    background: rgba(17,24,39,0.5);
    display: flex; justify-content: center; align-items: center;
    z-index: 10001; animation: fadeIn 0.2s ease;
  `;

  // 創建彈窗內容
  const modalContent = document.createElement('div');
  modalContent.className = 'options-modal-content';
  modalContent.style.cssText = `
    background: #fff; border-radius: 16px;
    box-shadow: 0 12px 30px rgba(0,0,0,0.18);
    max-width: 560px; width: min(92vw, 560px);
    max-height: 86vh; overflow-y: auto;
    animation: slideIn 0.25s ease; transform-origin: center;
  `;

  // 創建彈窗HTML
  modalContent.innerHTML = `
    <div class="modal-header" style="padding: 18px 20px 12px 20px; border-bottom: 1px solid #e5e7eb; position: sticky; top: 0; background: #fff; z-index: 1;">
      <h3 style="
        margin: 0; font-size: 18px; font-weight: 700; color: #111827; line-height: 1.4;
      ">${title}</h3>
      ${description ? `
        <p style="margin: 6px 0 0 0; font-size: 13px; color: #6b7280; line-height: 1.5;">${description}</p>
      ` : ''}
    </div>

    <div class="modal-body" style="padding: 16px 20px;">
      <div id="options-container" class="om-grid"></div>
    </div>

    <div class="modal-footer" style="padding: 12px 20px 16px 20px; display: flex; gap: 12px; justify-content: flex-end; border-top: 1px solid #e5e7eb; position: sticky; bottom: 0; background: #fff;">
      <button id="cancel-btn" class="om-btn om-btn-ghost">取消</button>
      <button id="confirm-btn" class="om-btn om-btn-primary">確定</button>
    </div>
  `;

  // 添加CSS動畫
  const style = document.createElement('style');
  style.textContent = `
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes slideIn {
      from {
        opacity: 0;
        transform: scale(0.9) translateY(-10px);
      }
      to {
        opacity: 1;
        transform: scale(1) translateY(0);
      }
    }
    .om-grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
    @media (min-width: 640px) { .om-grid { grid-template-columns: 1fr; } }
    @media (min-width: 768px) { .om-grid { grid-template-columns: 1fr; } }
    .option-item { margin: 0; padding: 12px; border: 1px solid #e5e7eb; border-radius: 10px; transition: box-shadow .2s, border-color .2s; }
    .option-item:hover { border-color: #c7d2fe; box-shadow: 0 2px 10px rgba(59,130,246,0.08); background: #fbfdff; }

    .radio-card { display: grid; grid-template-columns: 24px 1fr; align-items: start; gap: 10px; padding: 10px; border: 1px solid #e5e7eb; border-radius: 10px; cursor: pointer; }
    .radio-card:hover { border-color: #93c5fd; background: #f8fafc; }
    .radio-card input { margin-top: 3px; }

    .switch { position: relative; display: inline-block; width: 44px; height: 24px; vertical-align: middle; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider { position: absolute; cursor: pointer; inset: 0; background: #d1d5db; border-radius: 999px; transition: .2s; }
    .slider:before { position: absolute; content: ""; height: 20px; width: 20px; left: 2px; top: 2px; background: white; border-radius: 50%; transition: .2s; box-shadow: 0 1px 3px rgba(0,0,0,.2); }
    input:checked + .slider { background: #3b82f6; }
    input:checked + .slider:before { transform: translateX(20px); }

    .om-btn { padding: 10px 16px; border-radius: 8px; font-size: 14px; cursor: pointer; transition: transform .15s ease, background .15s ease, color .15s ease, border-color .15s ease; }
    .om-btn:active { transform: translateY(1px); }
    .om-btn-ghost { background: #fff; color: #374151; border: 1px solid #d1d5db; }
    .om-btn-ghost:hover { background: #f9fafb; border-color: #9ca3af; }
    .om-btn-primary { background: #3b82f6; color: #fff; border: none; }
    .om-btn-primary:hover { background: #2563eb; }

    /* Mobile bottom-sheet style */
    @media (max-width: 480px) {
      .options-modal-overlay { align-items: flex-end; }
      .options-modal-content { width: 100%; border-radius: 14px 14px 0 0; max-height: 92vh; }
    }
  `;
  document.head.appendChild(style);

  modalOverlay.appendChild(modalContent);

  // 渲染選項
  const optionsContainer = modalContent.querySelector('#options-container');
  renderOptions(optionsContainer, options);

  // 添加事件監聽
  const cancelBtn = modalContent.querySelector('#cancel-btn');
  const confirmBtn = modalContent.querySelector('#confirm-btn');

  const closeModal = () => {
    modalOverlay.style.animation = 'fadeIn 0.2s ease reverse';
    setTimeout(() => {
      if (modalOverlay.parentNode) {
        modalOverlay.parentNode.removeChild(modalOverlay);
      }
      document.head.removeChild(style);
    }, 200);
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
  const handleEsc = (e) => {
    if (e.key === 'Escape') {
      onCancel();
      closeModal();
      document.removeEventListener('keydown', handleEsc);
    }
  };
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
  const radioOptions = option.choices.map((choice, choiceIndex) => `
    <label class="radio-card">
      <input type="radio" name="option-${index}" value="${choice.value}" ${choice.value === option.default ? 'checked' : ''}>
      <div>
        <div style="font-weight:600;color:#111827;font-size:14px;">${choice.label}</div>
        ${choice.description ? `<div style=\"font-size:12px;color:#6b7280;margin-top:2px;\">${choice.description}</div>` : ''}
      </div>
    </label>
  `).join('');

  return `
    <div style="margin-bottom: 12px;">
      <h4 style="
        margin: 0 0 8px 0;
        font-size: 14px;
        font-weight: 600;
        color: #1f2937;
      ">${option.label}</h4>
      ${option.description ? `
        <p style="
          margin: 0 0 12px 0;
          font-size: 12px;
          color: #6b7280;
        ">${option.description}</p>
      ` : ''}
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
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
      <div>
        <div style="font-weight:600;color:#111827;font-size:14px;">${option.label}</div>
        ${option.description ? `<div style=\"font-size:12px;color:#6b7280;margin-top:2px;\">${option.description}</div>` : ''}
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
    <div style="margin-bottom: 8px;">
      <label style="
        display: block;
        font-size: 14px;
        font-weight: 600;
        color: #1f2937;
        margin-bottom: 4px;
      ">${option.label}</label>
      ${option.description ? `
        <p style="
          margin: 0 0 8px 0;
          font-size: 12px;
          color: #6b7280;
        ">${option.description}</p>
      ` : ''}
    </div>
    <select
      data-option-key="${option.key}"
      style="
        width: 100%;
        padding: 8px 12px;
        border: 1px solid #d1d5db;
        border-radius: 6px;
        font-size: 14px;
        background: white;
        cursor: pointer;
      "
    >
      ${selectOptions}
    </select>
  `;
}

// 創建數字輸入選項
function createNumberOption(option, index) {
  return `
    <div style="margin-bottom: 8px;">
      <label style="
        display: block;
        font-size: 14px;
        font-weight: 600;
        color: #1f2937;
        margin-bottom: 4px;
      ">${option.label}</label>
      ${option.description ? `
        <p style="
          margin: 0 0 8px 0;
          font-size: 12px;
          color: #6b7280;
        ">${option.description}</p>
      ` : ''}
    </div>
    <input
      type="number"
      data-option-key="${option.key}"
      value="${option.default || option.min || 1}"
      min="${option.min || 1}"
      max="${option.max || 100}"
      style="
        width: 100%;
        padding: 8px 12px;
        border: 1px solid #d1d5db;
        border-radius: 6px;
        font-size: 14px;
      "
    >
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
