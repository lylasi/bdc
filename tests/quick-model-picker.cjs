/**
 * 快速模型切換與完整思考模式入口。
 *
 * 執行（先開 python3 scripts/serve.py --port 8313）：
 *   PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/quick-model-picker.cjs
 *
 * 使用 tests/helpers/article-mock.cjs 的本機 profile / 文章 seeds，不連真實 AI。
 */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const mock = require('./helpers/article-mock.cjs');

const BASE = `http://127.0.0.1:${process.env.PORT || 8313}/`;
const ID = 'art_quick_model';
const SENTENCE = 'A leader can also listen.';
const BODY = `The leader guides the team. ${SENTENCE}`;
const DOC = {
    id: ID,
    title: 'Quick model',
    body: BODY,
    sourceType: 'paste',
    revision: 0,
    createdAt: '2026-11-02T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
    lastOpenedAt: '2026-11-02T00:00:00.000Z',
    analysis: {
        chinese_translation: '领导者带领团队，也会聆听。',
        word_alignment: [],
        detailed_analysis: [
            'The leader guides the team.',
            SENTENCE
        ].map((sentence) => ({
            word: 'leader',
            sentence,
            analysis: { meaning: '带领团队的人', pos: 'noun', phonetic: 'ˈliːdə', role: '主语' }
        })),
        sentence_analysis: [],
        phrase_analysis: [],
        paragraph_analysis: [
            { chinese_translation: '领导者带领团队，也会聆听。', word_alignment: [], detailed_analysis: [] }
        ]
    }
};

let checks = 0;
function check(name, condition, detail) {
    assert.ok(condition, `${name}: ${JSON.stringify(detail)}`);
    checks += 1;
    console.log(`PASS ${name}`);
}

function twoModelProfile() {
    const profile = JSON.parse(JSON.stringify(mock.PROFILE));
    profile.providers.mock.allowedModels = ['mock-model', 'mock-model-2'];
    profile.providers.mock.discoveredModels = [{ id: 'mock-model' }, { id: 'mock-model-2' }];
    for (const task of [
        'articleParagraphTranslation', 'articleSentenceTranslation', 'articleAnalysis',
        'articleCleanup', 'wordAnalysis'
    ]) delete profile.taskModels[task];
    return profile;
}

const EMPTY_PROFILE = {
    schemaVersion: 1,
    providers: {},
    credentials: {},
    taskModels: {},
    defaultModel: ''
};

const translated = (page, key, params) => page.evaluate(async ({ key, params }) => (
    await import('/modules/i18n.js')
).t(key, params), { key, params });

async function openRecord(page) {
    await page.waitForFunction(() => !!window.__assistant?.openWord);
    await page.evaluate(() => document.querySelector('#app-modal:not(.hidden) .modal-close-btn')?.click());
    await page.locator('#article-history-btn').click();
    await page.locator(`.ar-history-item[data-key="${ID}"] .ar-history-open`).click();
    await page.locator('.paragraph-pair[data-paragraph-index="0"]').waitFor();
}

async function setup(browser, { locale = 'zh-CN', profile = twoModelProfile(), withDoc = true } = {}) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await mock.initScript(context, { locale, profile });
    await context.addInitScript(() => {
        const settings = JSON.parse(localStorage.getItem('pen_global_settings') || '{}');
        settings.reading = { ...settings.reading, articleSidebarCollapsed: true, translationMask: false };
        localStorage.setItem('pen_global_settings', JSON.stringify(settings));
    });
    await context.route('**/*', (route) => ['127.0.0.1', 'localhost', 'provider.mock'].includes(
        new URL(route.request().url()).hostname
    ) ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(BASE + '#a', { waitUntil: 'domcontentloaded' });
    await page.locator('#article-ai-model-btn').waitFor();
    if (withDoc) {
        await page.waitForFunction(() => !!window.__assistant?.openWord);
        await mock.seedDocs(page, [DOC]);
        await page.evaluate(async () => (await import('/modules/article-store.js')).reloadScope());
        await openRecord(page);
    }
    return { context, page, errors };
}

const profileState = (page) => page.evaluate(async () => {
    const profile = (await import('/modules/ai-profile-storage.js')).loadAIProfile();
    return {
        taskModels: { ...profile.taskModels },
        taskThinking: { ...(profile.taskThinking || {}) },
        defaultModel: profile.defaultModel
    };
});

async function dismissGuestPrompt(page) {
    await page.evaluate(() => {
        const dismiss = Array.from(document.querySelectorAll('button')).find((btn) => (
            btn.textContent.trim() === '稍后' || btn.textContent.trim() === '稍後'
        ));
        dismiss?.click();
    });
}

async function openSettingsAiTab(page) {
    await dismissGuestPrompt(page);
    await page.click('#app-gear-btn');
    await page.click('#gm-settings');
    await page.waitForTimeout(300);
    await page.click('[data-gs-tab="ai"]');
    await page.waitForTimeout(400);
    await page.locator('details[data-keep-open="ai-tasks"] > summary').click();
    await page.locator('[data-ai-thinking]').first().waitFor();
}

async function runMain(browser) {
    const { context, page, errors } = await setup(browser);
    try {
        const articleButton = page.locator('#article-ai-model-btn');
        check('文章工具列有模型圖示', await articleButton.count() === 1 && await articleButton.isVisible());
        check('文章模型圖示標籤本地化', await articleButton.getAttribute('aria-label') === await translated(page, 'article.quickModelTitle'));

        await articleButton.click();
        const overlay = page.locator('.quick-model-overlay');
        await overlay.waitFor();
        check('點擊文章模型圖示開啟彈窗', await overlay.count() === 1);
        check('文章彈窗標題使用文章模型文案', (await overlay.locator('#quick-model-title').textContent()) === await translated(page, 'quickModel.articleTitle'));
        const taskButtons = await overlay.locator('[data-quick-task]').allTextContents();
        check('文章彈窗有四個任務切換', taskButtons.length === 4, taskButtons);
        check('預設停在段落翻譯', await overlay.getAttribute('data-current-task') === 'articleParagraphTranslation');
        check('沒有明確設定時預設勾選跟隨全局', await overlay.locator('.quick-model-list input[type="radio"][value=""]').isChecked());
        check('快速選單有思考模式', await overlay.locator('[data-quick-thinking]').count() === 1);
        check('思考模式預設顯示應用預設與目前檔位',
            (await overlay.locator('[data-quick-thinking] option[value=""]').textContent()).includes('关闭思考'));
        check('思考下拉保留箭頭樣式',
            (await overlay.locator('[data-quick-thinking]').evaluate((el) => getComputedStyle(el).backgroundImage)).includes('svg'));

        await overlay.locator('[data-quick-task="articleAnalysis"]').click();
        check('可切換到文章詳解任務', await overlay.getAttribute('data-current-task') === 'articleAnalysis');
        check('切換後任務按鈕狀態同步', await overlay.locator('[data-quick-task="articleAnalysis"]').getAttribute('aria-pressed') === 'true');
        await overlay.locator('[data-quick-task="articleParagraphTranslation"]').click();

        const modelValues = await overlay.locator('.quick-model-list input[type="radio"]').evaluateAll((nodes) => nodes.map((node) => node.value));
        check('模型清單先列跟隨全局再列可用模型', modelValues[0] === '' && modelValues.length === 3, modelValues);
        await overlay.locator('.quick-model-list input[type="radio"][value="mock:mock-model-2"]').check();
        await overlay.locator('[data-quick-thinking]').selectOption('high');
        await overlay.locator('[data-quick-action="confirm"]').click();
        await overlay.waitFor({ state: 'detached' });
        let profile = await profileState(page);
        check('確認後寫入段落翻譯模型', profile.taskModels.articleParagraphTranslation === 'mock:mock-model-2', profile.taskModels);
        check('確認後寫入段落翻譯思考模式', profile.taskThinking.articleParagraphTranslation === 'high', profile.taskThinking);
        check('確認後顯示已更新提示', /已更新/.test(await page.locator('#message-container').innerText()));

        await articleButton.click();
        await overlay.waitFor();
        check('重新開啟時勾選目前的明確設定', await overlay.locator('.quick-model-list input[type="radio"][value="mock:mock-model-2"]').isChecked());
        check('重新開啟時保留目前思考模式', await overlay.locator('[data-quick-thinking]').inputValue() === 'high');
        await overlay.locator('.quick-model-list input[type="radio"][value=""]').check();
        await overlay.locator('[data-quick-thinking]').selectOption('');
        await overlay.locator('[data-quick-action="confirm"]').click();
        await overlay.waitFor({ state: 'detached' });
        profile = await profileState(page);
        check('跟隨全局預設會刪除模型任務 key', !Object.prototype.hasOwnProperty.call(profile.taskModels, 'articleParagraphTranslation'), profile.taskModels);
        check('跟隨應用預設會刪除思考任務 key', !Object.prototype.hasOwnProperty.call(profile.taskThinking, 'articleParagraphTranslation'), profile.taskThinking);

        // 單詞 tooltip：兩條 render 路徑共用同一個 head actions 與委派處理器。
        await page.locator('.interactive-word[data-word="leader"]').first().click();
        const tooltip = page.locator('#word-analysis-tooltip');
        await tooltip.locator('.tooltip-meaning').waitFor();
        const wordModelButton = tooltip.locator('.btn-quick-model');
        check('單詞 tooltip 有模型圖示', await wordModelButton.count() === 1 && await wordModelButton.isVisible());
        check('單詞模型圖示標籤本地化', await wordModelButton.getAttribute('aria-label') === await translated(page, 'quickModel.wordTitle'));
        await wordModelButton.click();
        await overlay.waitFor();
        check('點擊單詞模型圖示開啟查詞模型清單', await overlay.getAttribute('data-current-task') === 'wordAnalysis');
        check('單一任務不顯示任務切換列', await overlay.locator('[data-quick-task]').count() === 0);
        check('查詞選單有思考模式', await overlay.locator('[data-quick-thinking]').count() === 1);
        await overlay.locator('.quick-model-list input[type="radio"][value="mock:mock-model-2"]').check();
        await overlay.locator('[data-quick-thinking]').selectOption('medium');
        await overlay.locator('[data-quick-action="confirm"]').click();
        await overlay.waitFor({ state: 'detached' });
        profile = await profileState(page);
        check('確認後寫入查詞模型', profile.taskModels.wordAnalysis === 'mock:mock-model-2', profile.taskModels);
        check('確認後寫入查詞思考模式', profile.taskThinking.wordAnalysis === 'medium', profile.taskThinking);
        check('切換模型後單詞 tooltip 仍保留', await tooltip.isVisible());
        check('關閉後焦點回到模型圖示', await wordModelButton.evaluate((el) => el === document.activeElement));

        // 單一任務且已選模型時，Shift+Tab 不可離開彈窗。
        await wordModelButton.click();
        await overlay.waitFor();
        await overlay.locator('[data-quick-thinking]').focus();
        await page.keyboard.press('Shift+Tab');
        check('單一任務選單 Shift+Tab 會回到確認鈕',
            await page.evaluate(() => document.activeElement?.getAttribute('data-quick-action') === 'confirm'));

        // tooltip 在選單開啟期間被非同步重繪：關閉後要聚焦新的模型圖示。
        const oldIcon = await wordModelButton.elementHandle();
        await page.evaluate(() => document.querySelector('#word-analysis-tooltip .btn-refresh-word')?.click());
        await page.waitForFunction((old) => {
            const current = document.querySelector('#word-analysis-tooltip .btn-quick-model');
            return !!current && current !== old;
        }, oldIcon);
        check('tooltip 重繪後產生新的模型圖示', true);
        await page.keyboard.press('Escape');
        await overlay.waitFor({ state: 'detached' });
        check('關閉後焦點回到重繪後的模型圖示',
            await page.evaluate(() => !!document.activeElement?.classList.contains('btn-quick-model')));

        // Esc 關閉 tooltip 並還原焦點。
        await tooltip.locator('.tooltip-close').click();
        await articleButton.click();
        await overlay.waitFor();
        await page.keyboard.press('Escape');
        await overlay.waitFor({ state: 'detached' });
        check('Esc 關閉文章模型彈窗並還原焦點', await articleButton.evaluate((el) => el === document.activeElement));

        await articleButton.click();
        await overlay.waitFor();
        await page.mouse.click(4, 4);
        await overlay.waitFor({ state: 'detached' });
        check('背景點擊關閉且還原焦點', await articleButton.evaluate((el) => el === document.activeElement));

        // 設定頁：所有任務列都要有思考模式。
        await openSettingsAiTab(page);
        const settingsState = await page.evaluate(() => ({
            rows: document.querySelectorAll('[data-ai-task]').length,
            thinking: document.querySelectorAll('[data-ai-thinking]').length,
            withThinking: document.querySelectorAll('.gs-ai-task-row-with-thinking').length,
            paragraph: document.querySelector('[data-ai-task="articleParagraphTranslation"]')
                ?.closest('.gs-ai-task-row')?.querySelector('.gs-ai-task-label')?.textContent || '',
            hint: Array.from(document.querySelectorAll('details[data-keep-open="ai-tasks"] .gs-hint'))
                .map((node) => node.textContent).join(' ')
        }));
        check('所有任務列都有思考模式下拉', settingsState.rows === 10 && settingsState.thinking === 10, settingsState);
        check('任務列使用思考模式雙欄樣式', settingsState.withThinking === 10, settingsState.withThinking);
        check('段落翻譯文案含全文', settingsState.paragraph.includes('全文'), settingsState.paragraph);
        check('思考模式提示說明所有任務可獨立設定', settingsState.hint.includes('所有任务') && settingsState.hint.includes('独立'), settingsState.hint);

        const thinkingSelect = page.locator('[data-ai-thinking="sentenceChecking"]');
        await thinkingSelect.focus();
        await thinkingSelect.selectOption('high');
        await page.waitForTimeout(200);
        profile = await profileState(page);
        check('思考模式即時儲存', profile.taskThinking.sentenceChecking === 'high', profile.taskThinking);
        check('思考模式變更後焦點保留在同一列', await page.locator('[data-ai-thinking="sentenceChecking"]').evaluate((el) => el === document.activeElement));
        check('沒有 JS 例外', errors.length === 0, errors);
    } finally {
        await context.close();
    }
}

async function runHk(browser) {
    const { context, page, errors } = await setup(browser, { locale: 'zh-HK' });
    try {
        const articleButton = page.locator('#article-ai-model-btn');
        check('zh-HK 文章模型圖示標籤', await articleButton.getAttribute('aria-label') === await translated(page, 'article.quickModelTitle'));
        await articleButton.click();
        const overlay = page.locator('.quick-model-overlay');
        await overlay.waitFor();
        const hkCopy = {
            title: await overlay.locator('#quick-model-title').textContent(),
            desc: await overlay.locator('.om-desc').textContent()
        };
        check('zh-HK 彈窗標題與說明', hkCopy.title === '文章 AI 模型'
            && hkCopy.desc === '選擇模型與思考模式後會自動儲存，並同步到全域設定。', hkCopy);
        await page.keyboard.press('Escape');
        await overlay.waitFor({ state: 'detached' });

        await openSettingsAiTab(page);
        const hk = await page.evaluate(() => ({
            paragraph: document.querySelector('[data-ai-task="articleParagraphTranslation"]')
                ?.closest('.gs-ai-task-row')?.querySelector('.gs-ai-task-label')?.textContent || '',
            hint: Array.from(document.querySelectorAll('details[data-keep-open="ai-tasks"] .gs-hint'))
                .map((node) => node.textContent).join(' ')
        }));
        check('zh-HK 段落翻譯文案含全文', hk.paragraph.includes('全文') && hk.paragraph.includes('段落'), hk.paragraph);
        check('zh-HK 思考模式提示說明所有任務可獨立設定', hk.hint.includes('所有任務') && hk.hint.includes('獨立'), hk.hint);
        check('zh-HK 沒有 JS 例外', errors.length === 0, errors);
    } finally {
        await context.close();
    }
}

async function runNoModels(browser) {
    const { context, page, errors } = await setup(browser, { profile: EMPTY_PROFILE, withDoc: false });
    try {
        // 空 profile 首次載入可能先顯示登入／引導彈窗；先關掉再操作工具列。
        await page.evaluate(() => document.querySelector('#app-modal:not(.hidden) .modal-close-btn')?.click());
        await page.locator('#app-modal').waitFor({ state: 'hidden' });
        await page.click('#article-ai-model-btn');
        const overlay = page.locator('.quick-model-overlay');
        await overlay.waitFor();
        const noModels = await translated(page, 'quickModel.noModels');
        check('無可用模型時顯示說明', (await overlay.locator('.quick-model-empty').textContent()) === noModels);
        check('無可用模型時確認鈕停用', await overlay.locator('[data-quick-action="confirm"]').isDisabled());
        await page.waitForFunction(() => !!document.activeElement?.closest('.quick-model-overlay'));
        check('無可用模型時焦點留在彈窗內', true);
        const profile = await profileState(page);
        check('無可用模型時不寫入任何任務', Object.keys(profile.taskModels).length === 0, profile.taskModels);
        await overlay.locator('[data-quick-action="cancel"]').click();
        await overlay.waitFor({ state: 'detached' });
        check('取消後焦點回到模型圖示', await page.locator('#article-ai-model-btn').evaluate((el) => el === document.activeElement));

        // 單一任務且無模型：沒有任務列、沒有 radio，焦點要落在可用的取消鈕。
        await page.evaluate(async () => {
            const module = await import('/modules/quick-model-picker.js');
            module.openQuickModelPicker({
                tasks: ['wordAnalysis'],
                initialTask: 'wordAnalysis',
                titleKey: 'quickModel.wordTitle'
            });
        });
        await overlay.waitFor();
        await page.waitForFunction(() => document.activeElement?.getAttribute('data-quick-action') === 'cancel');
        check('單一任務無模型時焦點落在取消鈕', true);
        await overlay.locator('[data-quick-action="cancel"]').click();
        await overlay.waitFor({ state: 'detached' });
        check('無模型情境沒有 JS 例外', errors.length === 0, errors);
    } finally {
        await context.close();
    }
}

async function runConcurrentProfileCases(browser) {
    // 只改模型：選單開啟後另一個分頁更新了思考模式，確認時不可回滾它。
    {
        const { context, page, errors } = await setup(browser, { withDoc: false });
        try {
            await dismissGuestPrompt(page);
            await page.locator('#article-ai-model-btn').click();
            const overlay = page.locator('.quick-model-overlay');
            await overlay.waitFor();
            await page.evaluate(async () => {
                const storage = await import('/modules/ai-profile-storage.js');
                const profile = storage.loadAIProfile();
                profile.taskThinking = { ...(profile.taskThinking || {}), articleParagraphTranslation: 'high' };
                storage.saveAIProfile(profile);
            });
            await overlay.locator('.quick-model-list input[type="radio"][value="mock:mock-model-2"]').check();
            await overlay.locator('[data-quick-action="confirm"]').click();
            await overlay.waitFor({ state: 'detached' });
            const state = await profileState(page);
            check('只改模型時保留並行更新的思考模式',
                state.taskModels.articleParagraphTranslation === 'mock:mock-model-2'
                && state.taskThinking.articleParagraphTranslation === 'high', state);
            check('並行思考更新情境沒有 JS 例外', errors.length === 0, errors);
        } finally {
            await context.close();
        }
    }

    // 只改思考：選單開啟後另一個分頁更新了模型，確認時不可回寫舊模型。
    {
        const { context, page, errors } = await setup(browser, { withDoc: false });
        try {
            await dismissGuestPrompt(page);
            await page.locator('#article-ai-model-btn').click();
            const overlay = page.locator('.quick-model-overlay');
            await overlay.waitFor();
            await page.evaluate(async () => {
                const storage = await import('/modules/ai-profile-storage.js');
                const profile = storage.loadAIProfile();
                profile.taskModels = { ...profile.taskModels, articleParagraphTranslation: 'mock:mock-model' };
                storage.saveAIProfile(profile);
            });
            await overlay.locator('[data-quick-thinking]').selectOption('high');
            await overlay.locator('[data-quick-action="confirm"]').click();
            await overlay.waitFor({ state: 'detached' });
            const state = await profileState(page);
            check('只改思考時保留並行更新的模型',
                state.taskModels.articleParagraphTranslation === 'mock:mock-model'
                && state.taskThinking.articleParagraphTranslation === 'high', state);
            check('並行模型更新情境沒有 JS 例外', errors.length === 0, errors);
        } finally {
            await context.close();
        }
    }

    // 完全未改動：確認只關閉，不應把並行更新回滾。
    {
        const { context, page, errors } = await setup(browser, { withDoc: false });
        try {
            await dismissGuestPrompt(page);
            await page.locator('#article-ai-model-btn').click();
            const overlay = page.locator('.quick-model-overlay');
            await overlay.waitFor();
            await page.evaluate(async () => {
                const storage = await import('/modules/ai-profile-storage.js');
                const profile = storage.loadAIProfile();
                profile.taskThinking = { ...(profile.taskThinking || {}), articleParagraphTranslation: 'high' };
                storage.saveAIProfile(profile);
            });
            await overlay.locator('[data-quick-action="confirm"]').click();
            await overlay.waitFor({ state: 'detached' });
            const state = await profileState(page);
            check('未改動時不覆寫並行更新',
                state.taskThinking.articleParagraphTranslation === 'high', state);
            check('未改動情境沒有 JS 例外', errors.length === 0, errors);
        } finally {
            await context.close();
        }
    }
}

async function runEdgeCases(browser) {
    // 目前任務模型已不可用：直接確認不可清除原設定。
    {
        const profile = twoModelProfile();
        profile.taskModels.articleParagraphTranslation = 'mock:missing-model';
        const { context, page, errors } = await setup(browser, { profile, withDoc: false });
        try {
            await dismissGuestPrompt(page);
            await page.locator('#article-ai-model-btn').click();
            const overlay = page.locator('.quick-model-overlay');
            await overlay.waitFor();
            check('不可用的目前模型仍會顯示', await overlay.locator('.quick-model-unavailable').count() === 1);
            check('不可用的目前模型預設被選取', await overlay.locator('.quick-model-unavailable input').isChecked());
            await overlay.locator('[data-quick-action="confirm"]').click();
            await overlay.waitFor({ state: 'detached' });
            const state = await profileState(page);
            check('未改選時保留不可用的目前模型',
                state.taskModels.articleParagraphTranslation === 'mock:missing-model', state.taskModels);
            check('不可用模型情境沒有 JS 例外', errors.length === 0, errors);
        } finally {
            await context.close();
        }
    }

    // 帳戶切換事件：選單應立即關閉。
    {
        const { context, page, errors } = await setup(browser, { withDoc: false });
        try {
            await dismissGuestPrompt(page);
            await page.locator('#article-ai-model-btn').click();
            const overlay = page.locator('.quick-model-overlay');
            await overlay.waitFor();
            await page.evaluate(() => window.dispatchEvent(new CustomEvent('bdc:auth-change', {
                detail: { event: 'ACCOUNT_CHANGED' }
            })));
            await overlay.waitFor({ state: 'detached' });
            check('帳戶切換事件會關閉模型選單', true);
            check('帳戶切換事件情境沒有 JS 例外', errors.length === 0, errors);
        } finally {
            await context.close();
        }
    }

    // 帳戶在選單開啟期間改變但沒有事件：確認前仍要擋下寫入。
    {
        const { context, page, errors } = await setup(browser, { withDoc: false });
        try {
            await dismissGuestPrompt(page);
            await page.locator('#article-ai-model-btn').click();
            const overlay = page.locator('.quick-model-overlay');
            await overlay.waitFor();
            await overlay.locator('.quick-model-list input[type="radio"][value="mock:mock-model-2"]').check();
            await page.evaluate(() => localStorage.setItem('sync_user_id', 'other-user'));
            await overlay.locator('[data-quick-action="confirm"]').click();
            await overlay.waitFor({ state: 'detached' });
            const state = await profileState(page);
            check('帳戶已變更時不寫入新帳戶', Object.keys(state.taskModels).length === 0, state.taskModels);
            check('帳戶已變更時顯示提示',
                /账号已切换|帳號已切換/.test(await page.locator('#message-container').innerText()));
            check('帳戶變更情境沒有 JS 例外', errors.length === 0, errors);
        } finally {
            await context.close();
        }
    }

    // 模型在選單開啟期間被移除：確認不得寫入過期值。
    {
        const { context, page, errors } = await setup(browser, { withDoc: false });
        try {
            await dismissGuestPrompt(page);
            await page.locator('#article-ai-model-btn').click();
            const overlay = page.locator('.quick-model-overlay');
            await overlay.waitFor();
            await overlay.locator('.quick-model-list input[type="radio"][value="mock:mock-model-2"]').check();
            await page.evaluate(async () => {
                const storage = await import('/modules/ai-profile-storage.js');
                const profile = storage.loadAIProfile();
                profile.providers.mock.allowedModels = ['mock-model'];
                profile.providers.mock.discoveredModels = [{ id: 'mock-model' }];
                storage.saveAIProfile(profile);
            });
            await overlay.locator('[data-quick-action="confirm"]').click();
            await page.waitForTimeout(100);
            check('模型在開啟期間被移除時選單不關閉', await overlay.count() === 1);
            check('模型被移除時顯示提示',
                /该模型已不可用|該模型已不可用/.test(await page.locator('#message-container').innerText()));
            const state = await profileState(page);
            check('模型被移除時未寫入', !state.taskModels.articleParagraphTranslation, state.taskModels);
            await overlay.locator('[data-quick-action="cancel"]').click();
            check('模型移除情境沒有 JS 例外', errors.length === 0, errors);
        } finally {
            await context.close();
        }
    }
}

(async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        await runMain(browser);
        await runHk(browser);
        await runNoModels(browser);
        await runEdgeCases(browser);
        await runConcurrentProfileCases(browser);
    } catch (error) {
        console.error('FAIL', error && error.stack ? error.stack : error);
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
    if (!process.exitCode) console.log(`\n=== ${checks} checks passed ===`);
})();
