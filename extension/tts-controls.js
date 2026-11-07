import { t } from './modules/i18n.js';
import { loadGlobalSettings, saveGlobalSettings, loadGlobalSecrets, saveGlobalSecrets } from './modules/settings.js';
import { describeSpeechTarget, getTtsServiceBaseUrl, getLocalSpeechVoices, getActiveAudioOwner, speakText, stopCurrentAudio, unlockAudioContext } from './modules/audio.js';
import { fetchTtsServiceVoices, formatVoiceLabel } from './modules/voices.js';
import { syncTTSAccount, getTTSAccountSyncState, ttsAccountStatusKey, TTS_SYNC_EVENT } from './modules/tts-account-sync.js';
import { TTS_PROFILE_EVENT } from './modules/tts-profile-storage.js';
import { normalizeTTSUrl } from './shared/tts-settings.mjs';

const TEST_OWNER = 'extension-tts-test';
const reasonKeys = {
    not_configured: 'extension.ttsReasonUnconfigured', timeout: 'extension.ttsReasonTimeout',
    playback_blocked: 'extension.ttsReasonBlocked', decode_failed: 'extension.ttsReasonFormat',
    audio_load_failed: 'extension.ttsReasonLoad', service_unavailable: 'extension.ttsReasonLoad',
    media_unavailable: 'extension.ttsReasonLoad'
};

function serviceUrl() {
    const value = getTtsServiceBaseUrl();
    return /your-tts|yourtts|placeholder|example\.(?:com|org|net)/i.test(value || '') ? '' : String(value || '').trim();
}

function validUrl(value) {
    try {
        const url = new URL(value);
        return /^https?:$/.test(url.protocol) && url.href.startsWith(url.origin + '/') && !url.search && !url.hash;
    } catch (_) { return false; }
}

export function createTTSControls(dom, { getText, onChange }) {
    let lastPlayback = null, testActive = false, testSequence = 0, catalogSequence = 0;
    let catalogController = null, catalogMessage = null, saveError = '', pending = null, pendingField = null, saveTimer;
    let pendingScope = '', formScope = getTTSAccountSyncState().key;
    // Private in-memory comparison only; never expose credentials through an
    // event, status message or diagnostic. Vault version acknowledgements must
    // not stop playback when its effective target and key did not change.
    const speechIdentity = () => {
        const settings = loadGlobalSettings();
        return JSON.stringify([getTTSAccountSyncState().key, settings.tts,
            settings.reading?.englishVariant, loadGlobalSecrets().ttsApiKey]);
    };
    let playbackIdentity = '';
    const playbackOptions = () => ({ forceLocal: loadGlobalSettings().tts?.extensionMode === 'device', timeoutMs: 10000 });
    const plan = () => describeSpeechTarget('english', playbackOptions());

    function render() {
        const target = lastPlayback || plan();
        const voice = target.voice || t('extension.ttsDefaultVoice');
        const short = t(target.source === 'remote' ? 'extension.ttsRemoteShort' : 'extension.ttsDeviceShort', { voice });
        const reason = target.fallbackReason && t(reasonKeys[target.fallbackReason] || 'extension.ttsReasonLoad');
        let detail;
        if (target.state === 'error') detail = t('extension.ttsPlaybackFailed', { reason: reason || t('extension.ttsReasonDevice') });
        else if (reason) detail = t('extension.ttsFallback', { reason, voice });
        else if (target.source === 'remote') detail = t(target.state === 'playing' || target.state === 'ended'
            ? 'extension.ttsServiceOk' : target.state === 'loading' ? 'extension.ttsServiceLoading' : 'extension.ttsServiceUnchecked',
        { host: target.host || '', voice });
        else detail = t('extension.ttsDeviceDetail', { voice });
        if (!lastPlayback && target.source === 'device' && !playbackOptions().forceLocal) {
            detail = t('extension.ttsFallback', { reason: t('extension.ttsReasonUnconfigured'), voice });
        }
        const warning = !!reason || (!lastPlayback && target.source === 'device' && !playbackOptions().forceLocal);
        if (saveError) detail = t(saveError);
        const state = saveError || target.state === 'error' ? 'error' : warning ? 'warning'
            : target.source === 'remote' && ['playing', 'ended'].includes(target.state) ? 'success' : 'info';
        dom.status.textContent = short;
        dom.status.title = detail + ' · ' + t('extension.ttsOpenSettings');
        dom.status.setAttribute('aria-label', dom.status.title);
        dom.status.dataset.state = state;
        dom.summary.textContent = target.source === 'remote' ? target.host : t('extension.ttsDeviceSource');
        dom.check.textContent = detail;
        dom.check.dataset.state = state;
        dom.test.dataset.i18n = testActive ? 'extension.lookupPronounceStop' : 'extension.ttsTest';
        dom.test.textContent = t(dom.test.dataset.i18n);
        dom.test.setAttribute('aria-pressed', String(testActive));
        dom.serviceFields.hidden = dom.mode.value === 'device';
        dom.saveNotice.hidden = !saveError;
        dom.saveNotice.textContent = saveError ? t(saveError) : '';
        dom.voicesNotice.hidden = !catalogMessage;
        dom.voicesNotice.textContent = catalogMessage ? t(catalogMessage.key, catalogMessage.params || {}) : '';
        const account = getTTSAccountSyncState();
        dom.accountState.textContent = t(ttsAccountStatusKey());
        dom.accountSync.disabled = ['syncing', 'guest'].includes(account.state);
    }

    function recordPlayback(status) {
        // Public display metadata only. Never retain an audio URL, key or raw error.
        lastPlayback = { state: status.state, source: status.source, host: status.host || '',
            voice: status.voice || '', fallbackReason: status.fallbackReason || '' };
        render();
    }

    function stopTest() {
        testSequence += 1;
        testActive = false;
        if (getActiveAudioOwner() === TEST_OWNER) stopCurrentAudio();
        if (lastPlayback?.state === 'loading') lastPlayback = null;
        render();
    }

    function invalidate(clearVoices = true) {
        stopTest();
        catalogSequence += 1;
        catalogController?.abort();
        catalogController = null;
        dom.loadVoices.disabled = false;
        catalogMessage = null;
        if (clearVoices) dom.voiceList.replaceChildren();
        lastPlayback = null;
        onChange();
    }

    function persist(settings, secrets) {
        saveError = '';
        try {
            if (settings) {
                saveGlobalSettings(settings);
                const current = loadGlobalSettings();
                for (const [group, fields] of Object.entries(settings)) {
                    for (const [key, value] of Object.entries(fields)) {
                        if (value && typeof value === 'object') {
                            if (Object.entries(value).some(([field, item]) => current[group]?.[key]?.[field] !== item)) throw new Error('save');
                        } else if (current[group]?.[key] !== value) throw new Error('save');
                    }
                }
            }
            if (secrets) {
                saveGlobalSecrets(secrets);
                if (loadGlobalSecrets().ttsApiKey !== secrets.ttsApiKey) throw new Error('save');
            }
            invalidate(!!secrets || !!settings?.tts && ('baseUrlCustom' in settings.tts || 'use' in settings.tts));
            if (settings?.tts?.baseUrlCustom !== undefined) dom.key.value = loadGlobalSecrets().ttsApiKey || '';
            playbackIdentity = speechIdentity();
        } catch (_) { saveError = 'extension.ttsSaveFailed'; }
        render();
    }

    function flush() {
        clearTimeout(saveTimer);
        const action = pending;
        pending = null; pendingField = null;
        if (pendingScope === getTTSAccountSyncState().key) action?.();
        pendingScope = '';
    }

    function bindInput(input, save) {
        input.addEventListener('input', () => {
            if (pendingField && pendingField !== input) flush();
            clearTimeout(saveTimer);
            pending = save; pendingField = input;
            pendingScope = getTTSAccountSyncState().key;
            saveTimer = setTimeout(flush, 300);
        });
        input.addEventListener('change', () => {
            if (pendingField && pendingField !== input) flush();
            pending = save; pendingField = input; pendingScope = getTTSAccountSyncState().key; flush();
        });
    }

    function deviceVoices() {
        const selected = loadGlobalSettings().tts?.deviceVoiceURI || '';
        const voices = getLocalSpeechVoices('english');
        const items = [{ value: '', label: t('extension.ttsDeviceAuto') }, ...voices.map((voice) => ({
            value: voice.voiceURI || voice.name, label: `${voice.name} (${voice.lang})`
        }))];
        if (selected && !items.some((item) => item.value === selected)) {
            items.push({ value: selected, label: t('extension.ttsVoiceUnavailable', { voice: selected }) });
        }
        const fingerprint = JSON.stringify(items);
        if (dom.deviceVoice.dataset.options !== fingerprint) {
            dom.deviceVoice.replaceChildren(...items.map((item) => {
                const option = document.createElement('option');
                option.value = item.value; option.textContent = item.label;
                return option;
            }));
            dom.deviceVoice.dataset.options = fingerprint;
        }
        dom.deviceVoice.value = selected;
    }

    function sync() {
        flush();
        const settings = loadGlobalSettings();
        dom.mode.value = settings.tts?.extensionMode === 'device' ? 'device' : 'auto';
        dom.url.value = serviceUrl();
        dom.key.value = loadGlobalSecrets().ttsApiKey || '';
        dom.accent.value = settings.reading?.englishVariant === 'en-US' ? 'en-US' : 'en-GB';
        const target = describeSpeechTarget('english');
        dom.voice.value = settings.tts?.selectedVoices?.[dom.accent.value] || (target.source === 'remote' ? target.voice : '') || '';
        deviceVoices(); playbackIdentity = speechIdentity(); render();
    }

    bindInput(dom.url, () => {
        const raw = dom.url.value.trim();
        const value = normalizeTTSUrl(raw);
        if (raw && (!validUrl(raw) || !value)) { saveError = 'extension.ttsUrlInvalid'; render(); return; }
        persist({ tts: { use: 'custom', baseUrlCustom: value } });
    });
    bindInput(dom.key, () => persist(null, { ttsApiKey: dom.key.value.trim() }));
    bindInput(dom.voice, () => persist({ tts: { selectedVoices: { [dom.accent.value]: dom.voice.value.trim() } } }));
    dom.mode.addEventListener('change', () => persist({ tts: { extensionMode: dom.mode.value } }));
    dom.accent.addEventListener('change', () => {
        persist({ reading: { englishVariant: dom.accent.value } });
        dom.voice.value = loadGlobalSettings().tts?.selectedVoices?.[dom.accent.value] || '';
    });
    dom.deviceVoice.addEventListener('change', () => persist({ tts: { deviceVoiceURI: dom.deviceVoice.value } }));
    dom.loadVoices.addEventListener('click', async () => {
        flush();
        if (!validUrl(dom.url.value.trim())) { saveError = 'extension.ttsUrlInvalid'; render(); return; }
        catalogController?.abort();
        const controller = catalogController = new AbortController();
        const sequence = ++catalogSequence;
        dom.loadVoices.disabled = true;
        catalogMessage = { key: 'extension.ttsVoicesLoading' }; render();
        try {
            const list = await fetchTtsServiceVoices({ baseUrl: dom.url.value.trim(), apiKey: dom.key.value.trim(), signal: controller.signal });
            if (sequence !== catalogSequence) return;
            const english = list.filter((voice) => /^en(?:-|$)/i.test(voice.locale));
            const choices = english.length ? english : list;
            dom.voiceList.replaceChildren(...choices.map((voice) => {
                const option = document.createElement('option');
                option.value = voice.id; option.label = formatVoiceLabel(voice); return option;
            }));
            catalogMessage = { key: 'extension.ttsVoicesLoaded', params: { count: choices.length } };
        } catch (error) {
            if (sequence === catalogSequence) catalogMessage = error?.status
                ? { key: 'extension.ttsVoicesFailedHttp', params: { status: error.status } }
                : { key: 'extension.ttsVoicesFailed' };
        } finally {
            if (sequence === catalogSequence) { dom.loadVoices.disabled = false; catalogController = null; render(); }
        }
    });
    dom.test.addEventListener('click', async () => {
        flush();
        if (testActive) { stopTest(); return; }
        if (dom.mode.value !== 'device' && dom.url.value.trim() && !validUrl(dom.url.value.trim())) {
            saveError = 'extension.ttsUrlInvalid'; render(); return;
        }
        if (saveError) return;
        const sequence = ++testSequence;
        testActive = true; lastPlayback = null; render();
        try {
            unlockAudioContext();
            await speakText(getText() || 'Hello', 'english', 0, null, null, { ...playbackOptions(), owner: TEST_OWNER,
                onStatus: (status) => {
                    if (sequence !== testSequence) return;
                    if (['ended', 'error'].includes(status.state)) testActive = false;
                    recordPlayback(status);
                } });
        } catch (_) {
            if (sequence === testSequence) { testActive = false; recordPlayback({ source: 'device', state: 'error' }); }
        }
    });
    window.speechSynthesis?.addEventListener?.('voiceschanged', () => { deviceVoices(); render(); });
    dom.accountSync.addEventListener('click', () => { flush(); syncTTSAccount({ force: true }); });
    window.addEventListener(TTS_SYNC_EVENT, () => {
        const nextScope = getTTSAccountSyncState().key;
        if (nextScope !== formScope) {
            clearTimeout(saveTimer); pending = null; pendingField = null; pendingScope = '';
            formScope = nextScope; saveError = ''; invalidate(); sync();
        } else render();
    });
    window.addEventListener(TTS_PROFILE_EVENT, (event) => {
        if (!['remote', 'credential'].includes(event.detail?.reason)) return;
        const next = speechIdentity();
        if (next === playbackIdentity) return;
        playbackIdentity = next;
        invalidate();
        if (!pending && ![dom.url, dom.key, dom.voice].includes(document.activeElement)) sync();
        else render();
    });
    window.addEventListener('storage', (event) => {
        if (event.key === 'pen_global_settings' || event.key === 'pen_global_secrets') { invalidate(); sync(); }
    });
    sync();
    return { sync, render, flush, stopTest, recordPlayback, getPlaybackOptions: playbackOptions,
        translate: () => { deviceVoices(); render(); } };
}
