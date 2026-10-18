// Small SVG QR renderer used by the admin login-code card.
// The encoder is the vendored MIT `qrcode-generator` build; see
// modules/vendor/qrcode-generator.LICENSE.txt.

import qrcode from './vendor/qrcode-generator.js';

export function createQrSvg(text, options = {}) {
    const value = String(text || '');
    if (!value) return '';
    const cellSize = Math.max(2, Math.min(8, Number(options.cellSize) || 4));
    const margin = Math.max(0, Number(options.margin) || cellSize * 3);
    const qr = qrcode(0, options.errorCorrectionLevel || 'M');
    qr.addData(value);
    qr.make();
    return qr.createSvgTag({
        cellSize,
        margin,
        scalable: true,
        title: String(options.title || ''),
        alt: String(options.alt || '')
    });
}

export function renderQrSvg(container, text, options = {}) {
    if (!container) return false;
    const svg = createQrSvg(text, options);
    if (!svg) {
        container.innerHTML = '';
        return false;
    }
    container.innerHTML = svg;
    return true;
}
