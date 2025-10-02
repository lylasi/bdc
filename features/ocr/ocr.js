import * as dom from '../../modules/dom.js';
import * as ui from '../../modules/ui.js';
import * as api from '../../modules/api.js';
import { OCR_CONFIG } from '../../ai-config.js';

// =================================
// 圖片 OCR 功能模組
// =================================

let mediaStream = null; // 相機串流
let lastImageDataUrl = '';
// 目前待識別的圖片清單
const images = []; // { id, dataUrl, name }

export function initOCR() {
    if (!dom.ocrSection) return; // 安全保護：若頁面未放置 OCR 區塊則跳過

    dom.ocrImageInput?.addEventListener('change', handleFileSelect);
    dom.ocrOpenCameraBtn?.addEventListener('click', openCamera);
    dom.ocrCaptureBtn?.addEventListener('click', captureFromCamera);
    dom.ocrCloseCameraBtn?.addEventListener('click', closeCamera);
    dom.ocrRunBtn?.addEventListener('click', runOCR);
    dom.ocrClearBtn?.addEventListener('click', clearOCR);
    // 縮圖刪除事件委派
    dom.ocrPreviewList?.addEventListener('click', (e) => {
        const btn = e.target.closest && e.target.closest('[data-action="remove"]');
        if (!btn) return;
        const id = btn.getAttribute('data-id');
        if (!id) return;
        const idx = images.findIndex(x => x.id === id);
        if (idx >= 0) {
            images.splice(idx, 1);
            renderPreviewList();
        }
    });
    // 常用模板 → 附加到提示詞
    dom.ocrHintPreset?.addEventListener('change', () => {
        try {
            const sel = dom.ocrHintPreset.value || '';
            if (!sel) return;
            const prev = (dom.ocrHint && dom.ocrHint.value) ? dom.ocrHint.value.trim() : '';
            dom.ocrHint.value = prev ? (prev + '\n\n' + sel) : sel;
        } finally {
            // 重置選單
            dom.ocrHintPreset.value = '';
        }
    });
    // 模型清單初始化
    try { initModelSelect(); } catch (_) {}
    // 使用相機優先（行動裝置）
    dom.ocrPreferCamera?.addEventListener('change', () => {
        try {
            if (!dom.ocrImageInput) return;
            if (dom.ocrPreferCamera.checked) {
                dom.ocrImageInput.setAttribute('capture', 'environment');
            } else {
                dom.ocrImageInput.removeAttribute('capture');
            }
        } catch (_) {}
    });
}

async function handleFileSelect(e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    try {
        for (const file of files) {
            if (!file.type || !file.type.startsWith('image/')) continue;
            const dataUrl = await fileToDataURL(file);
            const resized = await downscaleImage(dataUrl, { maxW: 1600, maxH: 1600, quality: 0.9 });
            addImage(resized || dataUrl, file.name || 'image');
        }
        renderPreviewList();
    } catch (err) {
        alert('讀取圖片失敗：' + (err?.message || err));
    }
}

function setPreview(dataUrl) {
    if (dom.ocrPreview) {
        dom.ocrPreview.src = dataUrl;
        dom.ocrPreview.classList.remove('hidden');
    }
}

async function openCamera() {
    try {
        if (mediaStream) return; // 已開啟
        const isSecure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
        const hasMedia = !!(navigator && navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function');
        if (!hasMedia) {
            // 盡量給出更易理解的提示，並回退到 file input 的 capture 模式
            const msg = isSecure
              ? '此瀏覽器不支援直接開啟相機，將改用「拍照上傳」。'
              : '當前非安全來源（需 HTTPS 或 localhost），瀏覽器封鎖了相機存取。將改用「拍照上傳」。\n\n解法：\n- 以 HTTPS 方式開啟本頁，或\n- 僅在同機器使用 http://localhost 開啟，或\n- 使用 ngrok/Cloudflare Tunnel 等提供的 HTTPS 域名。';
            alert(msg);
            try {
                if (dom.ocrImageInput) {
                    dom.ocrImageInput.setAttribute('capture', 'environment');
                    dom.ocrImageInput.click();
                    // 點擊之後立即移除，避免之後想從相簿選擇仍被強制開相機
                    setTimeout(() => dom.ocrImageInput && dom.ocrImageInput.removeAttribute('capture'), 0);
                }
            } catch (_) {}
            return;
        }
        if (!isSecure) {
            alert('當前非安全來源（需 HTTPS 或 localhost），瀏覽器可能封鎖相機。\n建議改用 HTTPS 或 localhost。');
        }
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        mediaStream = stream;
        if (dom.ocrVideo) {
            dom.ocrVideo.srcObject = stream;
            dom.ocrCameraArea?.classList.remove('hidden');
        }
    } catch (err) {
        alert('無法存取相機：' + (err?.message || err));
        try {
            if (dom.ocrImageInput) {
                dom.ocrImageInput.setAttribute('capture', 'environment');
                dom.ocrImageInput.click();
                setTimeout(() => dom.ocrImageInput && dom.ocrImageInput.removeAttribute('capture'), 0);
            }
        } catch (_) {}
    }
}

function closeCamera() {
    try {
        if (mediaStream) {
            mediaStream.getTracks().forEach(t => t.stop());
        }
    } catch (_) {}
    mediaStream = null;
    if (dom.ocrVideo) dom.ocrVideo.srcObject = null;
    dom.ocrCameraArea?.classList.add('hidden');
}

async function captureFromCamera() {
    if (!dom.ocrVideo) return;
    try {
        const w = dom.ocrVideo.videoWidth || 1280;
        const h = dom.ocrVideo.videoHeight || 720;
        if (!w || !h) return;
        const canvas = dom.ocrCanvas;
        if (!canvas) return;
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(dom.ocrVideo, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
        const resized = await downscaleImage(dataUrl, { maxW: 1600, maxH: 1600, quality: 0.9 });
        const finalUrl = resized || dataUrl;
        const name = `camera-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`;
        addImage(finalUrl, name);
        setPreview(finalUrl);
        renderPreviewList();
        // 可視需要關閉相機
        // closeCamera();
    } catch (err) {
        alert('拍照失敗：' + (err?.message || err));
    }
}

async function runOCR() {
    const list = images.length ? images.slice() : (lastImageDataUrl ? [{ id: 'single', dataUrl: lastImageDataUrl, name: 'image' }] : []);
    if (!list.length) {
        alert('請先上傳圖片或拍照');
        return;
    }
    const hint = (dom.ocrHint && dom.ocrHint.value && dom.ocrHint.value.trim()) || undefined;
    const model = dom.ocrModelSelect && dom.ocrModelSelect.value ? dom.ocrModelSelect.value : undefined;
    const merge = !!(dom.ocrMergeOutput && dom.ocrMergeOutput.checked);

    try {
        setBusy(true, `正在識別 ${list.length} 張圖片...`);
        const tasks = list.map(async (it, idx) => {
            try {
                const text = await api.ocrExtractTextFromImage(it.dataUrl, { temperature: 0.0, promptHint: hint, model });
                return { ok: true, id: it.id, name: it.name, text };
            } catch (e) {
                return { ok: false, id: it.id, name: it.name, error: e };
            }
        });
        const results = await Promise.all(tasks);
        const pieces = [];
        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            if (merge) {
                if (r.ok) pieces.push(r.text || '');
            } else {
                const header = `--- 圖片 ${i + 1}/${results.length}：${r.name} ---`;
                if (r.ok) {
                    pieces.push(`${header}\n${r.text || ''}`);
                } else {
                    pieces.push(`${header}\n[識別失敗] ${r.error?.message || r.error || ''}`);
                }
            }
        }
        if (dom.ocrResult) {
            dom.ocrResult.value = pieces.join('\n\n');
        }
    } catch (err) {
        alert('識別失敗：' + (err?.message || err));
    } finally {
        setBusy(false);
    }
}

function clearOCR() {
    lastImageDataUrl = '';
    images.splice(0, images.length);
    if (dom.ocrPreview) {
        dom.ocrPreview.src = '';
        dom.ocrPreview.classList.add('hidden');
    }
    if (dom.ocrResult) dom.ocrResult.value = '';
    if (dom.ocrImageInput) dom.ocrImageInput.value = '';
    renderPreviewList();
}

function setBusy(busy, text = '') {
    try {
        if (!dom.ocrRunBtn) return;
        dom.ocrRunBtn.disabled = !!busy;
        if (busy) {
            dom.ocrRunBtn.dataset._label = dom.ocrRunBtn.textContent;
            dom.ocrRunBtn.textContent = text || '處理中...';
        } else {
            const restore = dom.ocrRunBtn.dataset._label || '識別文字';
            dom.ocrRunBtn.textContent = restore;
        }
    } catch (_) {}
}

// ---------- 小工具 ----------

function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = (e) => reject(e);
        reader.readAsDataURL(file);
    });
}

async function downscaleImage(dataUrl, { maxW = 1600, maxH = 1600, quality = 0.9 } = {}) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            let { width, height } = img;
            const ratio = Math.min(maxW / width, maxH / height, 1);
            if (ratio < 1) {
                width = Math.round(width * ratio);
                height = Math.round(height * ratio);
            }
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            try {
                const out = canvas.toDataURL('image/jpeg', quality);
                resolve(out);
            } catch (_) {
                resolve(dataUrl);
            }
        };
        img.onerror = () => resolve(dataUrl);
        img.src = dataUrl;
    });
}

function addImage(dataUrl, name = 'image') {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    images.push({ id, dataUrl, name });
}

function renderPreviewList() {
    if (!dom.ocrPreviewList) return;
    const frag = document.createDocumentFragment();
    for (const it of images) {
        const cell = document.createElement('div');
        cell.style.position = 'relative';
        cell.style.border = '1px solid var(--border-color)';
        cell.style.borderRadius = '4px';
        cell.style.overflow = 'hidden';
        const img = document.createElement('img');
        img.src = it.dataUrl;
        img.alt = it.name || '';
        img.style.width = '100%';
        img.style.height = '80px';
        img.style.objectFit = 'cover';
        const rm = document.createElement('button');
        rm.textContent = '×';
        rm.setAttribute('type', 'button');
        rm.setAttribute('aria-label', '移除');
        rm.dataset.action = 'remove';
        rm.dataset.id = it.id;
        rm.style.position = 'absolute';
        rm.style.top = '2px';
        rm.style.right = '2px';
        rm.style.background = '#0008';
        rm.style.color = '#fff';
        rm.style.border = 'none';
        rm.style.borderRadius = '2px';
        rm.style.cursor = 'pointer';
        rm.style.fontSize = '12px';
        cell.appendChild(img);
        cell.appendChild(rm);
        frag.appendChild(cell);
    }
    dom.ocrPreviewList.innerHTML = '';
    dom.ocrPreviewList.appendChild(frag);
}

function initModelSelect() {
    if (!dom.ocrModelSelect) return;
    const current = loadModelSelection();
    const models = Array.isArray(OCR_CONFIG?.MODELS) && OCR_CONFIG.MODELS.length
      ? OCR_CONFIG.MODELS
      : [OCR_CONFIG?.DEFAULT_MODEL || OCR_CONFIG?.MODEL || 'gpt-4o-mini'];
    dom.ocrModelSelect.innerHTML = '';
    for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        dom.ocrModelSelect.appendChild(opt);
    }
    const toSelect = current || OCR_CONFIG?.DEFAULT_MODEL || OCR_CONFIG?.MODEL || models[0];
    dom.ocrModelSelect.value = toSelect;
    dom.ocrModelSelect.addEventListener('change', () => {
        try { localStorage.setItem('ocr.model', dom.ocrModelSelect.value); } catch (_) {}
    });
}

function loadModelSelection() {
    try { return localStorage.getItem('ocr.model') || ''; } catch (_) { return ''; }
}
