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
    document.querySelectorAll('.number-stepper-vertical').forEach(stepper => {
        const input = stepper.querySelector('.stepper-input');
        const minusBtn = stepper.querySelector('.stepper-minus');
        const plusBtn = stepper.querySelector('.stepper-plus');
        const min = parseInt(input.min, 10);
        const max = parseInt(input.max, 10);

        const updateButtons = (value) => {
            minusBtn.disabled = value <= min;
            plusBtn.disabled = value >= max;
        };

        const changeValue = (step) => {
            let currentValue = parseInt(input.value, 10);
            if (isNaN(currentValue)) currentValue = min;
            
            let newValue = currentValue + step;
            if (newValue < min) newValue = min;
            if (newValue > max) newValue = max;

            input.value = newValue;
            updateButtons(newValue);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        };

        minusBtn.addEventListener('click', () => changeValue(-1));
        plusBtn.addEventListener('click', () => changeValue(1));

        input.addEventListener('input', () => {
            let value = parseInt(input.value, 10);
            if (isNaN(value)) value = min;
            else if (value < min) value = min;
            else if (value > max) value = max;
            
            input.value = value;
            updateButtons(value);
        });

        updateButtons(parseInt(input.value, 10));
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