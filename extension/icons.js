// 擴充套件共用圖示：供動態產生的按鈕使用（靜態 HTML 內的圖示已直接內聯，
// 這裡只放相同路徑，避免 JS 生成元素時硬編字串或重複畫路徑）。
// 規則：圖示按鈕只掛 title / aria-label，不要用 data-i18n 覆寫內容。

const SVG_NS = 'http://www.w3.org/2000/svg';

export const ICONS = {
    sparkles: [
        'M12 3.5l1.7 4.3 4.3 1.7-4.3 1.7L12 15.5l-1.7-4.3L6 9.5l4.3-1.7L12 3.5z',
        'M18 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1z'
    ],
    more: [
        'M6 12h.01',
        'M12 12h.01',
        'M18 12h.01'
    ],
    back: [
        'M19 12H6',
        'M11.5 6.5L6 12l5.5 5.5'
    ],
    edit: [
        'M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3z',
        'M14 6l4 4'
    ],
    sliders: [
        'M4 8h9',
        'M17 8h3',
        'M4 16h4',
        'M12 16h8',
        'M15 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
        'M10 14a2 2 0 1 0 0 4 2 2 0 0 0 0-4z'
    ],
    close: [
        'M6.5 6.5l11 11',
        'M17.5 6.5l-11 11'
    ],
    external: [
        'M7 17L17 7',
        'M9 7h8v8'
    ],
    book: [
        'M12 6.6C10.5 5.4 8.6 4.9 6 4.9H4v13h2c2.6 0 4.5.5 6 1.6 1.5-1.1 3.4-1.6 6-1.6h2v-13h-2c-2.6 0-4.5.5-6 1.7z',
        'M12 6.6v13'
    ],
    article: [
        'M14 3.5H7.5A1.5 1.5 0 0 0 6 5v14a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V7.5L14 3.5z',
        'M14 3.5V8h4',
        'M9 13h6',
        'M9 16.5h4'
    ],
    plus: [
        'M12 5.5v13',
        'M5.5 12h13'
    ],
    panel: [
        'M6 4.5h12A2.5 2.5 0 0 1 20.5 7v10a2.5 2.5 0 0 1-2.5 2.5H6A2.5 2.5 0 0 1 3.5 17V7A2.5 2.5 0 0 1 6 4.5z',
        'M14.5 4.5v15'
    ],
    send: [
        'M12 19.5V5',
        'M6 11l6-6 6 6'
    ],
    stop: [
        'M8 8h8v8H8z'
    ]
};

/** 建立可直接 append 的 SVG 圖示；name 不存在時回傳 null。 */
export function createIcon(name, className = '') {
    const paths = ICONS[name];
    if (!paths) return null;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    // 以呈現屬性帶上線條樣式，讓沒有 .ext-icon-only 容器的場合也保持一致。
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.7');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    if (className) svg.setAttribute('class', className);
    for (const data of paths) {
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', data);
        svg.appendChild(path);
    }
    return svg;
}

/** 圖示按鈕：只設定 title 與 aria-label，內容為 SVG，不掛 data-i18n。 */
export function createIconButton({ id, icon, label, className = 'ext-btn ext-btn-quiet ext-btn-sm ext-icon-only', type = 'button' }) {
    const button = document.createElement('button');
    button.type = type;
    if (id) button.id = id;
    button.className = className;
    if (label) {
        button.title = label;
        button.setAttribute('aria-label', label);
    }
    const svg = createIcon(icon);
    if (svg) button.appendChild(svg);
    return button;
}
