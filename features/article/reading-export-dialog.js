// 兩個閱讀匯出入口共用的格式、音訊及重試視窗；檔案只留在本次視窗記憶體。
import * as ui from '../../modules/ui.js';
import * as readingStore from '../../modules/reading-store.js';
import * as articleStore from '../../modules/article-store.js';
import * as readingExport from '../../modules/reading-export.js';
import { t, getLocaleTag } from '../../modules/i18n.js';

let generation = 0;
let activeDialog = null;
let selection = { format: 'html', fullText: false, chat: true };

function invalidateExport() {
    generation += 1;
    activeDialog?.cancel();
}

for (const name of ['bdc:article-loaded', 'bdc:articles-scope-changed', 'bdc:locale-change']) {
    document.addEventListener(name, invalidateExport);
}

function scopeDescription(scope, choice) {
    const parts = [scope.title];
    if (scope.contentVersion) parts.push(`${t('article.readingExportVersion')}: ${scope.contentVersion.slice(0, 12)}`);
    parts.push(t('article.exportScopeSummary', { items: scope.itemCount, notes: scope.noteCount, messages: scope.messageCount }));
    if (choice.format === 'html') parts.push(t('article.exportHtmlScope'));
    else if (!choice.fullText && !choice.chat) parts.push(t('article.exportNoteOnly'));
    parts.push(t('article.exportLocalOnly'));
    return parts.filter(Boolean).join(' · ');
}

function errorMessage(error) {
    const limits = { count: readingExport.READING_AUDIO_LIMITS.count, size: readingExport.READING_AUDIO_LIMITS.bytes / 1024 / 1024 };
    const keys = {
        audio_count: 'article.exportAudioCountError',
        audio_size: 'article.exportAudioSizeError',
        audio_format: 'article.exportAudioFormatError',
        audio_read_failed: 'article.exportAudioReadError',
        note_save_failed: 'article.saveFailedRetry',
        stale_scope: 'article.exportStale'
    };
    return t(keys[error] || 'article.readingExportFailed', limits);
}

export async function openReadingExportDialog({ articleId, getArticleId, flushDrafts, fullBackup = false }) {
    activeDialog?.cancel();
    const token = ++generation;
    const context = readingStore.captureReadingContext();
    const articleContext = articleStore.captureArticleContext();
    const locale = getLocaleTag();
    let cancelled = false;
    const isCurrent = () => !cancelled && token === generation
        && getArticleId() === articleId && getLocaleTag() === locale
        && context.scope === articleContext.scope
        && readingStore.isReadingContextActive(context)
        && articleStore.isArticleContextActive(articleContext);
    if (!articleId) {
        ui.displayMessage(t('article.readingNoArticle'), 'warning');
        return { ok: false, error: 'no_article' };
    }
    let scope;
    if (!fullBackup) {
        scope = await readingExport.describeReadingScope(articleId, { context, isCurrent });
        if (!isCurrent()) return { ok: false, error: 'stale_scope' };
        if (!scope.ok) {
            ui.displayMessage(errorMessage(scope.error), 'error');
            return scope;
        }
    }
    if (!isCurrent()) return { ok: false, error: 'stale_scope' };

    return new Promise((resolve) => {
        let files = [];
        let busy = false;
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            if (activeDialog === session) activeDialog = null;
            resolve(result);
        };
        const session = { cancel: () => overlay.querySelector('#cancel-btn').click() };
        const overlay = ui.showOptionsModal({
            title: t(fullBackup ? 'article.readingExportAccountBackup' : 'article.exportScopeTitle'),
            description: fullBackup ? t('article.exportBackupDescription') : scopeDescription(scope, selection),
            options: fullBackup ? [] : [
                {
                    type: 'radio', key: 'format', label: t('article.exportFormat'), default: selection.format,
                    choices: [
                        { value: 'html', label: t('article.exportHtml'), description: t('article.exportHtmlHint') },
                        { value: 'markdown', label: t('article.exportMarkdown'), description: t('article.exportMarkdownHint') }
                    ]
                },
                { type: 'checkbox', key: 'fullText', label: t('article.exportIncludeFullText'), default: selection.fullText },
                { type: 'checkbox', key: 'chat', label: t('article.exportIncludeChat'), default: selection.chat }
            ],
            closeOnConfirm: false,
            onCancel: () => {
                cancelled = true;
                files = [];
                finish({ ok: false, error: 'cancelled' });
            },
            onConfirm: async (choice, close) => {
                if (busy || settled) return;
                if (!isCurrent()) {
                    showError('stale_scope');
                    return;
                }
                const validation = fullBackup || choice.format !== 'html' ? { ok: true } : readingExport.validateReadingAudioFiles(files);
                if (!validation.ok) {
                    showError(validation.error);
                    return;
                }
                if (!fullBackup) selection = { format: choice.format, fullText: !!choice.fullText, chat: !!choice.chat };
                setBusy(true);
                status.classList.remove('error');
                status.textContent = t('article.exportSavingDrafts');
                try {
                    const flushed = await flushDrafts(isCurrent);
                    if (!isCurrent()) return;
                    if (!flushed) {
                        showError('note_save_failed');
                        return;
                    }
                    const options = {
                        articleId, context, isCurrent,
                        includeFullText: !!choice.fullText, includeChat: !!choice.chat,
                        audioFiles: files,
                        onProgress: (stage, values) => {
                            if (isCurrent()) status.textContent = t(stage, values);
                        }
                    };
                    status.textContent = t('article.exportReadingSnapshot');
                    const result = fullBackup
                        ? await readingExport.exportFullBackupFile(options)
                        : choice.format === 'html'
                            ? await readingExport.exportReadingEditionFile(options)
                            : await readingExport.exportReadingNoteFile(options);
                    if (!isCurrent()) return;
                    if (!result?.ok) {
                        showError(result?.error);
                        return;
                    }
                    files = [];
                    close();
                    finish(result);
                    ui.displayMessage(t(fullBackup ? 'article.readingExportJsonDone'
                        : choice.format === 'html' ? 'article.exportEditionDone' : 'article.readingExportDone'), 'success');
                } catch (_) {
                    if (isCurrent()) showError('export_failed');
                } finally {
                    if (!settled && overlay.isConnected) {
                        setBusy(false);
                        if (!isCurrent()) showError('stale_scope');
                    }
                }
            }
        });
        activeDialog = session;
        overlay.classList.add('reading-export-dialog');
        const body = overlay.querySelector('.modal-body');
        const confirm = overlay.querySelector('#confirm-btn');
        const status = document.createElement('p');
        status.className = 'reading-export-status';
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        overlay.querySelector('.modal-content').insertBefore(status, overlay.querySelector('.modal-footer'));
        confirm.textContent = t('article.exportStart');

        function setBusy(value) {
            busy = value;
            overlay.setAttribute('aria-busy', String(value));
            overlay.querySelectorAll('input, button[data-audio-remove]').forEach((element) => { element.disabled = value; });
            confirm.disabled = value;
            if (!value) updateFormat();
        }

        function showError(error) {
            status.textContent = errorMessage(error);
            status.classList.add('error');
            confirm.textContent = t('article.exportRetry');
        }

        let audioSection;
        let audioList;
        let audioSummary;
        if (!fullBackup) {
            audioSection = document.createElement('section');
            audioSection.className = 'reading-export-audio';
            const label = document.createElement('label');
            label.htmlFor = 'reading-export-audio-files';
            label.textContent = t('article.exportAudioLabel');
            const help = document.createElement('p');
            help.id = 'reading-export-audio-help';
            help.className = 'om-hint';
            help.textContent = `${t('article.exportAudioLocal')} ${t('article.exportAudioHelp', {
                count: readingExport.READING_AUDIO_LIMITS.count, size: readingExport.READING_AUDIO_LIMITS.bytes / 1024 / 1024
            })}`;
            const input = document.createElement('input');
            input.type = 'file';
            input.id = label.htmlFor;
            input.accept = readingExport.READING_AUDIO_ACCEPT;
            input.multiple = true;
            input.setAttribute('aria-describedby', help.id);
            input.addEventListener('change', () => {
                files.push(...input.files);
                input.value = '';
                renderAudio();
                const validation = readingExport.validateReadingAudioFiles(files);
                if (!validation.ok) showError(validation.error);
            });
            audioSummary = document.createElement('p');
            audioSummary.setAttribute('aria-live', 'polite');
            audioList = document.createElement('ul');
            audioSection.append(label, help, input, audioSummary, audioList);
            body.appendChild(audioSection);
            overlay.querySelectorAll('input[type="radio"], input[type="checkbox"]').forEach((input) => {
                input.addEventListener('change', () => {
                    updateFormat();
                    status.textContent = '';
                    status.classList.remove('error');
                });
            });
            renderAudio();
        }

        function renderAudio() {
            audioSummary.textContent = t('article.exportAudioSelected', { count: files.length, size: (files.reduce((size, file) => size + file.size, 0) / 1024 / 1024).toFixed(2) });
            audioList.replaceChildren();
            files.forEach((file, index) => {
                const row = document.createElement('li');
                const name = document.createElement('span');
                name.textContent = file.name;
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'btn tertiary';
                remove.dataset.audioRemove = String(index);
                remove.setAttribute('aria-label', t('article.exportAudioRemove', { name: file.name }));
                remove.textContent = '×';
                remove.addEventListener('click', () => {
                    files.splice(index, 1);
                    renderAudio();
                    status.textContent = '';
                    status.classList.remove('error');
                });
                row.append(name, remove);
                audioList.appendChild(row);
            });
        }

        function updateFormat() {
            if (fullBackup) return;
            const format = overlay.querySelector('.radio-group input:checked').value;
            const fullText = overlay.querySelector('input[data-option-key="fullText"]');
            const chat = overlay.querySelector('input[data-option-key="chat"]');
            fullText.closest('.option-item').hidden = format === 'html';
            fullText.disabled = busy || format === 'html';
            audioSection.hidden = format !== 'html';
            overlay.querySelector('.om-desc').textContent = scopeDescription(scope, { format, fullText: fullText.checked, chat: chat.checked });
        }
        updateFormat();
    });
}
