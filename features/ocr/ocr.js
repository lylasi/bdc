import * as dom from '../../modules/dom.js';
import * as ui from '../../modules/ui.js';
import * as api from '../../modules/api.js';
import { markdownToHtml } from '../../modules/markdown.js';
import { OCR_CONFIG } from '../../ai-config.js';

// =================================
// 圖片 OCR 功能模組
// =================================

let mediaStream = null; // 相機串流
let lastImageDataUrl = '';
// 目前待識別的圖片清單
const images = []; // { id, dataUrl, name, hash? }
let dragSourceIndex = -1;
let currentRun = null; // { abort, cancelled, perItem: Map, counters }
const imageHashes = new Set();

export function initOCR() {
    if (!dom.ocrSection) return; // 安全保護：若頁面未放置 OCR 區塊則跳過

    dom.ocrImageInput?.addEventListener('change', handleFileSelect);
    dom.ocrOpenCameraBtn?.addEventListener('click', openCamera);
    dom.ocrCaptureBtn?.addEventListener('click', captureFromCamera);
    dom.ocrCloseCameraBtn?.addEventListener('click', closeCamera);
    dom.ocrRunBtn?.addEventListener('click', runOCR);
    dom.ocrClearBtn?.addEventListener('click', clearOCR);
    // 停止/取消
    dom.ocrStopBtn?.addEventListener('click', stopOCR);
    // 區域貼上（在 OCR 區塊內有效）
    dom.ocrSection?.addEventListener('paste', handleClipboardPaste);
    // 縮圖區域拖放上傳
    if (dom.ocrPreviewList) {
        ;['dragenter','dragover'].forEach(ev => dom.ocrPreviewList.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); dom.ocrPreviewList.classList.add('dragover'); }));
        ;['dragleave','drop'].forEach(ev => dom.ocrPreviewList.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); dom.ocrPreviewList.classList.remove('dragover'); }));
        dom.ocrPreviewList.addEventListener('drop', async (e) => {
            try {
                const files = e.dataTransfer && e.dataTransfer.files ? e.dataTransfer.files : [];
                const added = await addImagesFromFiles(files);
                if (added > 0) ui.displayMessage(`已加入 ${added} 張圖片`, 'success', 1800);
            } catch (err) {
                ui.displayMessage(`加入圖片失敗：${err?.message || err}`, 'error');
            }
        });
    }
    // 顯示模式切換（純文本/Markdown 預覽）
    dom.ocrDisplayMode?.addEventListener('change', () => {
        const mode = dom.ocrDisplayMode.value;
        if (mode === 'md') {
            dom.ocrResult?.classList.add('hidden');
            dom.ocrResultPreview?.classList.remove('hidden');
            renderResultPreview();
        } else {
            dom.ocrResult?.classList.remove('hidden');
            dom.ocrResultPreview?.classList.add('hidden');
        }
    });
    dom.ocrResult?.addEventListener('input', () => {
        if (dom.ocrDisplayMode && dom.ocrDisplayMode.value === 'md') renderResultPreview();
    });
    // 縮圖事件委派：點右上角 × 刪除；點縮圖直接彈出大圖（無右側預覽區）
    dom.ocrPreviewList?.addEventListener('click', (e) => {
        const rmBtn = e.target.closest && e.target.closest('[data-action="remove"]');
        if (rmBtn) {
            const id = rmBtn.getAttribute('data-id');
            if (!id) return;
            const idx = images.findIndex(x => x.id === id);
            if (idx >= 0) {
                const removed = images.splice(idx, 1)[0];
                try { if (removed && removed.hash) imageHashes.delete(removed.hash); } catch(_) {}
                renderPreviewList();
            }
            return;
        }
        const retryBtn = e.target.closest && e.target.closest('.thumb-status[data-action="retry"]');
        if (retryBtn) {
            const id = retryBtn.getAttribute('data-id');
            if (id) retrySingleImage(id);
            return;
        }
        const img = e.target && e.target.tagName === 'IMG' ? e.target : null;
        if (img) {
            const overlay = document.createElement('div');
            overlay.className = 'lightbox-overlay';
            overlay.innerHTML = `<img src="${img.src}" alt="preview">`;
            overlay.addEventListener('click', () => overlay.remove());
            document.body.appendChild(overlay);
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

    // 自適應高度（提示詞、識別結果）
    try {
        const autoGrow = (el, { min = 0, max } = {}) => {
            if (!el) return;
            el.style.height = 'auto';
            const target = Math.max(min, el.scrollHeight + 2);
            const applied = (typeof max === 'number' && max > 0) ? Math.min(target, max) : target;
            el.style.height = applied + 'px';
        };
        const minHint = 132;
        const minResult = 320;
        let maxResult = Math.floor(window.innerHeight * 0.7);
        autoGrow(dom.ocrHint, { min: minHint });
        autoGrow(dom.ocrResult, { min: minResult, max: maxResult });
        dom.ocrHint?.addEventListener('input', () => autoGrow(dom.ocrHint, { min: minHint }));
        dom.ocrResult?.addEventListener('input', () => autoGrow(dom.ocrResult, { min: minResult, max: maxResult }));
        window.addEventListener('resize', () => {
            maxResult = Math.floor(window.innerHeight * 0.7);
            autoGrow(dom.ocrResult, { min: minResult, max: maxResult });
        }, { passive: true });
    } catch (_) {}
}

async function handleFileSelect(e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    try {
        await addImagesFromFiles(files);
    } catch (err) {
        alert('讀取圖片失敗：' + (err?.message || err));
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
        try {
            const hash = await hashDataUrl(finalUrl);
            if (imageHashes.has(hash)) {
                ui.displayMessage('略過重複圖片', 'info', 1500);
            } else {
                addImage(finalUrl, name, hash);
            }
        } catch (_) {
            addImage(finalUrl, name);
        }
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
        if (currentRun) { alert('任務進行中，請先停止或等候完成'); return; }
        currentRun = { abort: new AbortController(), cancelled: false, perItem: new Map(), counters: { total: list.length, success: 0, failed: 0, cancelled: 0, completed: 0 } };
        setControlsRunning(true);
        const MAX = Math.max(1, parseInt(OCR_CONFIG?.maxConcurrency ?? 5, 10) || 5);
        const total = list.length; let completed = 0;
        setBusy(true, `正在識別 0/${total} 張圖片...`);
        updateProgressUI();
        list.forEach(it => setThumbStatus(it.id, '待處理'));
        const results = new Array(total);
        async function worker(idx) {
            const it = list[idx]; if (!it) return;
            setThumbStatus(it.id, '處理中');
            try {
                const ac = new AbortController();
                currentRun.perItem.set(it.id, ac);
                const text = await api.ocrExtractTextFromImage(it.dataUrl, { temperature: 0.0, promptHint: hint, model, signal: ac.signal });
                results[idx] = { ok: true, id: it.id, name: it.name, text };
                setThumbStatus(it.id, '完成');
                currentRun.counters.success += 1;
            } catch (e1) {
                if (currentRun?.cancelled || e1?.name === 'AbortError') {
                    results[idx] = { ok: false, id: it.id, name: it.name, error: e1 };
                    setThumbStatus(it.id, '已取消');
                    currentRun.counters.cancelled += 1;
                } else {
                    try {
                        const ac2 = new AbortController();
                        currentRun.perItem.set(it.id, ac2);
                        const text = await api.ocrExtractTextFromImage(it.dataUrl, { temperature: 0.0, promptHint: hint, model, signal: ac2.signal });
                        results[idx] = { ok: true, id: it.id, name: it.name, text };
                        setThumbStatus(it.id, '完成');
                        currentRun.counters.success += 1;
                    } catch (e2) {
                        results[idx] = { ok: false, id: it.id, name: it.name, error: e2 };
                        setThumbStatus(it.id, '失敗');
                        currentRun.counters.failed += 1;
                    }
                }
            } finally {
                completed += 1; currentRun.counters.completed = completed;
                setBusy(true, `正在識別 ${completed}/${total} 張圖片...`);
                updateProgressUI();
            }
        }
        const runners = []; let next = 0;
        for (let c = 0; c < Math.min(MAX, total); c++) {
            runners.push((async function loop(){
                while (next < total && !(currentRun && currentRun.cancelled)) { const cur = next++; await worker(cur); }
            })());
        }
        await Promise.all(runners);
        if (currentRun?.cancelled) { for (let i=0;i<total;i++){ if (!results[i]) { setThumbStatus(list[i].id, '已取消'); currentRun.counters.cancelled += 1; } } }
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
            // 識別完成後根據內容自適應高度
            try {
                const minResult = 320;
                const maxResult = Math.floor(window.innerHeight * 0.7);
                dom.ocrResult.style.height = 'auto';
                dom.ocrResult.style.height = Math.min(Math.max(minResult, dom.ocrResult.scrollHeight + 2), maxResult) + 'px';
            } catch (_) {}
            if (dom.ocrDisplayMode && dom.ocrDisplayMode.value === 'md') renderResultPreview();
        }
        try { ui.displayMessage(`識別完成：${currentRun?.counters?.total||list.length} 張（成功 ${currentRun?.counters?.success||0}，失敗 ${currentRun?.counters?.failed||0}，取消 ${currentRun?.counters?.cancelled||0}）`, 'success', 2200); } catch(_) {}
        try { setBusy(true, '完成！'); setTimeout(() => setBusy(false), 1000); } catch(_) {}
    } catch (err) {
        alert('識別失敗：' + (err?.message || err));
    } finally {
        setBusy(false);
        setControlsRunning(false);
        currentRun = null;
        updateProgressUI(true);
    }
}

function clearOCR() {
    lastImageDataUrl = '';
    images.splice(0, images.length);
    if (dom.ocrResult) dom.ocrResult.value = '';
    if (dom.ocrImageInput) dom.ocrImageInput.value = '';
    if (dom.ocrResultPreview) dom.ocrResultPreview.innerHTML = '';
    try { imageHashes.clear(); } catch(_) {}
    updateProgressUI(true);
    renderPreviewList();
}

function setBusy(busy, text = '') {
    try {
        if (!dom.ocrRunBtn) return;
        dom.ocrRunBtn.disabled = !!busy;
        if (busy) {
            if (!dom.ocrRunBtn.dataset._label) dom.ocrRunBtn.dataset._label = dom.ocrRunBtn.textContent || '識別文字';
            dom.ocrRunBtn.textContent = text || '處理中...';
        } else {
            const restore = dom.ocrRunBtn.dataset._label || '識別文字';
            dom.ocrRunBtn.textContent = restore;
            try { delete dom.ocrRunBtn.dataset._label; } catch(_) {}
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

function addImage(dataUrl, name = 'image', hash) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const it = { id, dataUrl, name };
    if (hash) { it.hash = hash; imageHashes.add(hash); }
    images.push(it);
}

function renderPreviewList() {
    if (!dom.ocrPreviewList) return;
    clearDropHighlights();
    dragSourceIndex = -1;
    const frag = document.createDocumentFragment();
    images.forEach((it, index) => {
        const cell = document.createElement('div');
        cell.className = 'thumb-cell ocr-thumb-cell';
        cell.dataset.index = String(index);
        cell.dataset.id = it.id;
        cell.setAttribute('draggable', 'true');
        const img = document.createElement('img');
        img.src = it.dataUrl; img.alt = it.name || ''; img.draggable = false;
        const rm = document.createElement('button'); rm.textContent = '×'; rm.type='button'; rm.setAttribute('aria-label','移除'); rm.dataset.action='remove'; rm.dataset.id=it.id;
        cell.appendChild(img); cell.appendChild(rm);
        cell.addEventListener('dragstart', (ev) => { dragSourceIndex = index; cell.classList.add('dragging'); try{ ev.dataTransfer.effectAllowed='move'; }catch(_){}});
        cell.addEventListener('dragend', () => { dragSourceIndex=-1; cell.classList.remove('dragging'); clearDropHighlights(); });
        cell.addEventListener('dragover', (ev) => { if (dragSourceIndex===-1 || dragSourceIndex===index) return; ev.preventDefault(); try{ ev.dataTransfer.dropEffect='move'; }catch(_){ } cell.classList.add('drop-target'); });
        cell.addEventListener('dragleave', () => cell.classList.remove('drop-target'));
        cell.addEventListener('drop', (ev) => { if (dragSourceIndex===-1 || dragSourceIndex===index) return; ev.preventDefault(); cell.classList.remove('drop-target'); const from=dragSourceIndex, to=index; if (from<0||to<0||from===to) return; const [moved]=images.splice(from,1); images.splice(to,0,moved); dragSourceIndex=-1; clearDropHighlights(); renderPreviewList(); });
        frag.appendChild(cell);
    });
    dom.ocrPreviewList.innerHTML = '';
    dom.ocrPreviewList.appendChild(frag);
}

function clearDropHighlights() {
    if (!dom.ocrPreviewList) return; try { dom.ocrPreviewList.querySelectorAll('.drop-target, .dragging').forEach(el => el.classList.remove('drop-target','dragging')); } catch(_) {}
}

function renderResultPreview() {
    try {
        if (!dom.ocrResultPreview) return;
        const md = (dom.ocrResult && dom.ocrResult.value) || '';
        dom.ocrResultPreview.innerHTML = markdownToHtml(md);
    } catch (_) {}
}

// ---------- 進度與取消 ----------
function setControlsRunning(running) {
    try {
        if (dom.ocrRunBtn) dom.ocrRunBtn.disabled = !!running;
        if (dom.ocrStopBtn) dom.ocrStopBtn.disabled = !running;
        if (dom.ocrOpenCameraBtn) dom.ocrOpenCameraBtn.disabled = !!running;
        if (dom.ocrClearBtn) dom.ocrClearBtn.disabled = !!running;
        if (dom.ocrImageInput) dom.ocrImageInput.disabled = !!running;
        if (dom.ocrModelSelect) dom.ocrModelSelect.disabled = !!running;
    } catch (_) {}
}

function updateProgressUI(finalize = false) {
    try {
        const c = currentRun?.counters; const total = c?.total || 0; const done = c?.completed || 0;
        if (dom.ocrProgressBar) dom.ocrProgressBar.style.width = (total>0 ? Math.round(done/total*100) : 0) + '%';
        if (dom.ocrProgressText) {
            if (!total) dom.ocrProgressText.textContent = finalize ? '已完成' : '尚未開始';
            else dom.ocrProgressText.textContent = `${done}/${total} 完成（成功 ${c?.success||0}，失敗 ${c?.failed||0}，取消 ${c?.cancelled||0}）`;
        }
    } catch (_) {}
}

function stopOCR() {
    if (!currentRun) return;
    try {
        currentRun.cancelled = true;
        for (const ac of currentRun.perItem.values()) { try { ac.abort(new DOMException('User cancelled','AbortError')); } catch(_) {} }
        try { currentRun.abort.abort(new DOMException('User cancelled','AbortError')); } catch(_) {}
        ui.displayMessage('已停止，未完成的將標記為取消', 'warning', 1800);
    } catch (_) {}
}

// ---------- 加圖/貼上/去重 ----------
async function addImagesFromFiles(files = []) {
    const arr = Array.from(files || []);
    const valid = arr.filter(f => f && typeof f.type === 'string' && f.type.startsWith('image/'));
    if (!valid.length) return 0;
    let added = 0, skippedDup = 0, lastErr = null;
    for (const file of valid) {
        try {
            const name = file.name || 'image';
            const dataUrl = await fileToDataURL(file);
            const resized = await downscaleImage(dataUrl, { maxW: 1600, maxH: 1600, quality: 0.9 });
            const finalUrl = resized || dataUrl;
            const hash = await hashDataUrl(finalUrl);
            if (imageHashes.has(hash)) { skippedDup += 1; continue; }
            addImage(finalUrl, name, hash);
            added += 1;
        } catch (e) { lastErr = e; }
    }
    if (added) renderPreviewList();
    if (skippedDup) try { ui.displayMessage(`略過 ${skippedDup} 張重複圖片`, 'info', 1500); } catch(_) {}
    if (!added && lastErr) throw lastErr;
    return added;
}

function setThumbStatus(id, label) {
    try {
        if (!dom.ocrPreviewList || !id) return;
        const esc = (s) => { try { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/"/g,'\\"'); } catch(_) { return String(s); } };
        const cell = dom.ocrPreviewList.querySelector(`[data-id="${esc(id)}"]`);
        if (!cell) return;
        let badge = cell.querySelector('.thumb-status');
        if (!badge) { badge = document.createElement('div'); badge.className = 'thumb-status'; cell.appendChild(badge); }
        badge.textContent = String(label || '');
        if (label === '失敗' || label === '已取消') { badge.dataset.action='retry'; badge.dataset.id=id; badge.title='點擊重試'; }
        else { delete badge.dataset.action; delete badge.dataset.id; badge.removeAttribute('title'); }
        if (!label) badge.remove();
    } catch (_) {}
}

async function retrySingleImage(id) {
    if (!id) return; if (currentRun) { ui.displayMessage('任務執行中，請先停止或等待完成','warning'); return; }
    const it = images.find(x => x.id === id); if (!it) return;
    const hint = (dom.ocrHint && dom.ocrHint.value && dom.ocrHint.value.trim()) || undefined;
    const model = dom.ocrModelSelect && dom.ocrModelSelect.value ? dom.ocrModelSelect.value : undefined;
    setThumbStatus(id, '處理中');
    try {
        const text = await api.ocrExtractTextFromImage(it.dataUrl, { temperature:0.0, promptHint: hint, model });
        setThumbStatus(id, '完成');
        const header = `--- 單張重試：${it.name} ---`;
        if (dom.ocrResult) { const prev = dom.ocrResult.value || ''; const add = `${header}\n${text || ''}`; dom.ocrResult.value = prev ? (prev+'\n\n'+add) : add; if (dom.ocrDisplayMode && dom.ocrDisplayMode.value === 'md') renderResultPreview(); }
        ui.displayMessage('重試完成','success',1500);
    } catch (e) { setThumbStatus(id,'失敗'); ui.displayMessage(`重試失敗：${e?.message || e}`,'error'); }
}

// 穩健雜湊：優先使用 WebCrypto；若不可用（非安全來源或舊瀏覽器），改用輕量 32-bit FNV-1a
async function hashDataUrl(dataUrl) {
    const str = String(dataUrl || '');
    try {
        if (typeof crypto !== 'undefined' && crypto && crypto.subtle && typeof TextEncoder !== 'undefined') {
            const enc = new TextEncoder();
            const buf = enc.encode(str);
            const digest = await crypto.subtle.digest('SHA-256', buf);
            const bytes = new Uint8Array(digest);
            let hex = '';
            for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
            return hex;
        }
    } catch (_) { /* fall through to fallback */ }
    // Fallback: FNV-1a 32-bit（足夠用於去重；非安全用途）
    let h = 0x811c9dc5 >>> 0;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0; // *16777619
    }
    return 'fnv1a-' + h.toString(16).padStart(8, '0');
}

// 貼上（區域）
async function handleClipboardPaste(event) {
    if (!dom.ocrSection || !dom.ocrSection.classList.contains('active')) return;
    const t = event.target;
    if (t && (t === dom.ocrHint || t === dom.ocrResult || t.isContentEditable || (/^(INPUT|TEXTAREA)$/).test(t.tagName))) return;
    const cd = event.clipboardData; if (!cd || !cd.items || !cd.items.length) return;
    const imgs = Array.from(cd.items).filter(it => it.kind === 'file' && /^image\//.test(it.type)); if (!imgs.length) return;
    event.preventDefault();
    try {
        const files = imgs.map(it => it.getAsFile()).filter(Boolean);
        const added = await addImagesFromFiles(files);
        if (added > 0) ui.displayMessage(`已加入 ${added} 張圖片`, 'success', 1800);
    } catch (err) { alert('貼上圖片失敗：' + (err?.message || err)); }
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
