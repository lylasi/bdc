/**
 * 全域設定：即時儲存 + 分類面板的回歸巡檢。
 *
 * 執行（先開 python3 scripts/serve.py --port 8313）：
 *   PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/settings-autosave.cjs
 *
 * 檢查重點：
 *  1. 底部只有「完成」，沒有「儲存／取消」；改任何選項都立即寫入。
 *  2. tts.use / tts.baseUrlCustom / tts.selectedVoices 這類同層欄位不會互相覆蓋。
 *  3. 文字輸入（TTS 金鑰）在 debounce 後寫入，關閉前最後一刻的輸入也不會掉。
 *  4. 切換介面語言會在面板內重建（不重開頁面），且仍留在同一個分類。
 *  5. 重新載入後設定仍在。
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path = require('path');

const PORT = process.env.PORT || 8313;
const BASE = `http://127.0.0.1:${PORT}/`;
const results = [];
function check(name, ok, detail) {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`);
}

(async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));

    const openSettings = async () => {
        await page.evaluate(() => {
            const dismiss = Array.from(document.querySelectorAll('button')).find((btn) => btn.textContent.trim() === '稍后' || btn.textContent.trim() === '稍後');
            if (dismiss) dismiss.click();
        });
        await page.click('#app-gear-btn');
        await page.waitForTimeout(200);
        await page.click('#gm-settings');
        await page.waitForTimeout(500);
    };
    const store = () => page.evaluate(() => ({
        settings: JSON.parse(localStorage.getItem('pen_global_settings') || '{}'),
        secrets: JSON.parse(localStorage.getItem('pen_global_secrets') || '{}')
    }));

    try {
        await page.goto(BASE, { waitUntil: 'load' });
        await page.evaluate(() => localStorage.clear());
        await page.reload({ waitUntil: 'load' });
        await page.waitForTimeout(600);
        await openSettings();

        const shell = await page.evaluate(() => ({
            tabs: Array.from(document.querySelectorAll('[data-gs-tab]')).map((btn) => btn.dataset.gsTab),
            save: !!document.querySelector('#gs-save'),
            cancel: !!document.querySelector('#gs-cancel'),
            footerButtons: Array.from(document.querySelectorAll('#modal-actions button')).map((btn) => btn.id || btn.textContent.trim()),
            saved: (document.querySelector('#gs-saved') || {}).textContent || ''
        }));
        check('設定面板有四個分類', shell.tabs.join(',') === 'general,voice,ai,tools', shell.tabs);
        check('底部只有「完成」，沒有儲存／取消', shell.save && !shell.cancel && shell.footerButtons.length === 1, shell.footerButtons);
        check('開啟時不顯示「已自動保存」', shell.saved === '', shell.saved);

        // 主題：點一下即存
        await page.click('.gs-theme-btn[data-theme-id="blue"]');
        let state = await store();
        check('主題即時寫入 pen_global_settings', state.settings.theme === 'blue', state.settings.theme);
        check('改動後顯示已自動保存', /已自动保存|已自動儲存/.test(await page.innerText('#gs-saved')));

        // 語音：來源 / 自訂 URL / 聲音清單三個同層欄位都要留下
        await page.click('[data-gs-tab="voice"]');
        await page.click('label:has(#gs-tts-use-custom)');
        state = await store();
        check('TTS 來源即時寫入', state.settings.tts && state.settings.tts.use === 'custom', state.settings.tts);
        check('自訂來源時顯示 URL 欄位', await page.isVisible('#gs-tts-url-custom'));

        await page.fill('#gs-tts-url-custom', 'http://192.168.1.9:9000');
        await page.waitForTimeout(900);
        state = await store();
        check('自訂 TTS URL 在輸入後寫入', state.settings.tts.baseUrlCustom === 'http://192.168.1.9:9000', state.settings.tts);

        await page.fill('#gs-tts-key', 'tts-test-key');
        await page.waitForTimeout(900);
        state = await store();
        check('TTS 金鑰寫入 pen_global_secrets', state.secrets.ttsApiKey === 'tts-test-key', state.secrets.ttsApiKey);
        check('同層 TTS 欄位沒有被覆蓋', state.settings.tts.use === 'custom' && state.settings.tts.baseUrlCustom === 'http://192.168.1.9:9000', state.settings.tts);

        const voiceValue = await page.evaluate(() => {
            const select = document.querySelector('[data-voice-group="en-GB"]');
            if (!select || select.options.length < 2) return '';
            select.value = select.options[1].value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return select.value;
        });
        await page.waitForTimeout(300);
        state = await store();
        check('選擇語音即時寫入 selectedVoices', !!voiceValue && state.settings.tts.selectedVoices['en-GB'] === voiceValue,
            state.settings.tts.selectedVoices);

        // 朗讀偏好
        await page.click('label:has(#gs-read-en-us)');
        state = await store();
        check('英語朗讀偏好即時寫入', state.settings.reading && state.settings.reading.englishVariant === 'en-US', state.settings.reading);

        // 助手開關
        await page.click('[data-gs-tab="tools"]');
        await page.click('label:has(#gs-assistant-stream)');
        state = await store();
        check('助手串流開關即時寫入', state.settings.assistant && state.settings.assistant.stream === false, state.settings.assistant);

        // 語言：在面板內重建，不重開頁面
        await page.click('[data-gs-tab="general"]');
        await page.selectOption('#gs-interface-locale', 'zh-HK');
        await page.waitForTimeout(700);
        state = await store();
        const rebuilt = await page.evaluate(() => ({
            lang: document.documentElement.lang,
            tabs: Array.from(document.querySelectorAll('[data-gs-tab]')).map((btn) => btn.textContent.trim()),
            active: document.querySelector('[data-gs-tab].active')?.dataset.gsTab,
            panelVisible: !!document.querySelector('[data-gs-panel="general"]:not([hidden])')
        }));
        check('切換語言即時寫入並重建面板', state.settings.language.interfaceLocale === 'zh-HK' && rebuilt.lang === 'zh-HK', state.settings.language);
        check('重建後停在目前分類並換成香港繁體', rebuilt.active === 'general' && rebuilt.panelVisible && rebuilt.tabs.includes('助手與工具'), rebuilt);

        // 完成 → 關閉
        await page.click('#gs-save');
        await page.waitForTimeout(300);
        const closed = await page.evaluate(() => ({
            hidden: document.querySelector('#app-modal').classList.contains('hidden'),
            footerHidden: document.querySelector('#modal-actions').hidden
        }));
        check('按「完成」關閉面板並收起底部列', closed.hidden && closed.footerHidden, closed);

        // 重新載入後仍在
        await page.reload({ waitUntil: 'load' });
        await page.waitForTimeout(700);
        state = await store();
        const persisted = state.settings;
        check('重新載入後設定仍在',
            persisted.theme === 'blue' && persisted.tts.use === 'custom'
            && persisted.tts.baseUrlCustom === 'http://192.168.1.9:9000'
            && persisted.reading.englishVariant === 'en-US'
            && persisted.language.interfaceLocale === 'zh-HK',
            persisted);
        check('沒有 JS 例外', errors.length === 0, errors);
    } catch (error) {
        check('巡檢腳本本身執行成功', false, String(error && error.message ? error.message : error));
    } finally {
        await context.close();
        await browser.close();
    }

    const failed = results.filter((item) => !item.ok);
    console.log(`\nsummary: ${results.length - failed.length}/${results.length} passed`);
    if (failed.length) process.exitCode = 1;
})();
