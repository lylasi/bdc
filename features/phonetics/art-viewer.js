import { art, viewer as v } from './page-dom.js';
import { t } from '../../modules/i18n.js';

let frames = [], index = 0, scale = 1, x = 0, y = 0, start = null, pinch = null;
const pointers = new Map();
function transform() {
    const bounds = v.stage.getBoundingClientRect();
    const maxX = bounds.width * (scale - 1) / 2;
    const maxY = bounds.height * (scale - 1) / 2;
    x = Math.max(-maxX, Math.min(maxX, x));
    y = Math.max(-maxY, Math.min(maxY, y));
    v.image.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    v.reset.textContent = `${Math.round(scale * 100)}%`;
    v.out.disabled = scale <= 1;
    v.in.disabled = scale >= 4;
}
function zoom(value) { scale = Math.max(1, Math.min(4, value)); transform(); }
function show(next) {
    index = Math.max(0, Math.min(frames.length - 1, next));
    const frame = frames[index];
    v.image.src = frame.src;
    v.image.alt = frame.alt || t('phonetics.artTitle');
    v.caption.textContent = frame.alt || '';
    v.count.textContent = `${index + 1} / ${frames.length}`;
    v.prev.disabled = index === 0;
    v.next.disabled = index === frames.length - 1;
    x = y = 0; zoom(1);
}
export function renderArt(items) {
    art.replaceChildren();
    items.forEach((frame, i) => {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'art-preview';
        const img = document.createElement('img');
        img.src = frame.src; img.alt = frame.alt || t('phonetics.artTitle');
        const label = document.createElement('span');
        label.textContent = `${t('phonetics.enlarge')} · ${i + 1} / ${items.length}`;
        button.append(img, label);
        button.addEventListener('click', () => {
            frames = items; v.viewer.showModal(); show(i);
        });
        art.append(button);
    });
}
v.close.addEventListener('click', () => v.viewer.close());
v.viewer.addEventListener('close', () => { pointers.clear(); start = pinch = null; });
v.prev.addEventListener('click', () => show(index - 1));
v.next.addEventListener('click', () => show(index + 1));
v.in.addEventListener('click', () => zoom(scale + .5));
v.out.addEventListener('click', () => zoom(scale - .5));
v.reset.addEventListener('click', () => { x = y = 0; zoom(1); });
v.viewer.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault(); show(index + (event.key === 'ArrowLeft' ? -1 : 1));
    }
});
function distance() {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
}
v.stage.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    v.stage.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, {x: event.clientX, y: event.clientY});
    if (pointers.size === 1) start = {x: event.clientX, y: event.clientY, panX: x, panY: y, swipe: scale === 1};
    if (pointers.size === 2) { pinch = {distance: distance(), scale}; start = null; }
});
v.stage.addEventListener('pointermove', event => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, {x: event.clientX, y: event.clientY});
    if (pointers.size === 2 && pinch) zoom(pinch.scale * distance() / Math.max(1, pinch.distance));
    else if (start && scale > 1) {
        x = start.panX + event.clientX - start.x;
        y = start.panY + event.clientY - start.y; transform();
    }
});
function release(event) {
    if (event.type === 'pointerup' && pointers.size === 1 && start?.swipe && scale === 1) {
        const dx = event.clientX - start.x, dy = event.clientY - start.y;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) show(index + (dx < 0 ? 1 : -1));
    }
    pointers.delete(event.pointerId); start = pinch = null;
}
v.stage.addEventListener('pointerup', release);
v.stage.addEventListener('pointercancel', release);
window.addEventListener('resize', transform);
