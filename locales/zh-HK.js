export default {
    phonetics: {
        artTitle: "發音口型圖",
        enlarge: "點擊放大",
        previous: "上一張",
        next: "下一張",
        zoomIn: "放大",
        zoomOut: "縮小",
        artHint: "左右滑動切圖；雙指縮放，放大後拖動查看。點擊百分比還原。",

        optional: "括號內為可選音，不加入逐音跟讀。",
        failedAuth: "音標查詢服務拒絕存取，請檢查 BDC 的 AI 服務及密鑰設定；仍可聽單詞發音。",
        failedTimeout: "音標查詢逾時，請重試；仍可聽單詞發音。",
        failedNetwork: "無法連接音標查詢服務，請檢查網絡及 BDC 的 AI 服務網址；仍可聽單詞發音。",
        failedFormat: "查詢服務沒有傳回有效的對應口音音標，可重試；仍可聽單詞發音。",

        "enable": "啟用拆音練習",
        "settingHint": "預設關閉；開啟後在單詞本列表和學習模式的單詞詳情顯示入口。獨立工具隨時可用，發音沿用目前渠道及英美音源。",
        "practice": "拆音練習",
        "independent": "獨立開啟",
        "close": "關閉",
        "title": "單詞拆音",
        "back": "返回背單詞",
        "chart": "完整音標表",
        "word": "英文單詞或詞組",
        "search": "查詢及拆音",
        "uk": "英音",
        "us": "美音",
        "play": "聽單詞發音",
        "stop": "停止播放",
        "loading": "正在查詢音標，可先聽單詞發音…",
        "failed": "音標查詢失敗，可繼續聽單詞發音，或按查詢重試。",
        "invalid": "請輸入英文單詞或詞組（最多 80 個字元），可包含空格、連字號及撇號。",
        "local": "已核對的本機示例讀法",
        "provided": "使用詞條提供的音標及口音",
        "ai": "AI 參考音標，尚未經人工核對",
        "unknown": "按詞條原音標 /{ipa}/ 拆音，口音尚未確認。英美選項只切換試聽示範，不改寫原音標；括號內為可選音，不加入逐音跟讀。",
        "choose": "此字有多種讀法，請選擇。",
        "noResult": "暫未取得可用音標，仍可聽單詞發音。",
        "note": "單詞發音使用設定中選擇的渠道及音源；多讀音字的朗讀可能與所選音標不同。獨立音示範不等同於自然連讀。",
        "missing": "/{symbol}/ 暫無獨立示範，可聽完整單詞。",
        "audioFailed": "播放失敗，請檢查目前語音渠道及音源後重試。",
        "playing": "正在播放…",
        "done": "播放完畢",
        "sounds": "按一個音，聽示範",
        "retry": "重新查詢",
        "mixed": "目前頁面為 HTTPS，所選區域網絡語音網址為 HTTP。請切換可用的 HTTPS 渠道，或從本機 HTTP 網站開啟。",
        "badVoice": "所選音源與口音不符，請在設定中重新選擇。",
        "lookupUnavailable": "沒有可用的音標查詢結果。",
        "reference": "詞條原音標 · 口音未確認",
        "sequence": "逐音跟讀",
        "loadingAudio": "正在載入音訊…"
},
    app: {
        subtitle: '紙上默書 · 生字 · 學習',
        documentTitle: '背單詞應用',
        title: 'PEN子背單詞',
        settings: '設定'
    },
    nav: {
        aria: '主導覽',
        more: '更多',
        vocabulary: { full: '生字簿', short: '生' },
        dictation: { full: '默書模式', short: '默' },
        learning: { full: '學習模式', short: '學' },
        qa: { full: '問答訓練', short: '問' },
        article: { full: '文章詳解', short: '文' },
        ocr: { full: '圖片識別', short: '圖' },
        quiz: { full: '隨堂測驗', short: '測' }
    },
    settings: {
        globalTitle: '全局設定',
        languageLabel: '顯示語言',
        languageHint: '介面及 AI 回覆使用所選語言，學習內容保持原樣。',
        theme: '配色主題', themeHint: '只更換主色，其餘介面顏色與排版保持不變。', themeTeal: '墨青', themeIndigo: '靛藍', themeViolet: '紫羅蘭', themeSlate: '石墨',
        savedLocal: '已儲存（僅本機）',
        saveFailed: '儲存失敗：', ttsSource: 'TTS 來源', remote: '遠端', local: '本機', custom: '自訂', ttsSourceHint: '一般使用者只需選擇來源；需要自訂時再輸入 URL', customTtsUrl: '自訂 TTS 基礎 URL', ttsKey: 'TTS API Key（只儲存在本機）', englishVoicePreference: '英語朗讀首選', britishEnglish: '英音 en-GB', americanEnglish: '美音 en-US', defaultBritish: '未指定時預設英音', chineseVoicePreference: '中文朗讀首選', mandarin: '普通話 zh-CN', cantonese: '粵語 zh-HK', ttsVoices: 'TTS 聲音（只顯示：美音、英音、廣東話、普通話）', reloadList: '重新載入清單', englishAmerican: '英語（美音 en-US）', englishBritish: '英語（英音 en-GB）', cantoneseVoice: '粵語（廣東話 zh-HK）', mandarinVoice: '中文（普通話 zh-CN）', previewVoice: '試聽', loading: '正在載入...', voiceLoadHint: '如載入失敗，請確認 TTS 基礎 URL 或 ai-config.js 的 voicesUrl 可以存取。', assistant: 'AI 助手', enableAssistant: '啟用助手', streaming: '串流回應', assistantHint: '右下角入口 · 串流回應更順暢', cancel: '取消', save: '儲存', localOnlyHint: '設定只儲存在本機，不會同步到雲端。'
        ,localeCn: '中國大陸簡體中文', localeHk: '香港繁體中文', providerSettings: 'AI Provider 設定', addProvider: '新增 provider', enabled: '啟用', fetched: '已擷取', fetching: '擷取中', fetchFailed: '擷取失敗', notFetched: '尚未擷取', fetchModels: '擷取模型', remove: '移除', name: '名稱', displayName: '顯示名稱', apiUrlOptional: 'API URL（選填）', modelsUrlOptional: 'Models URL（選填）', deriveApiUrl: '留空則由 Base URL 推導', deriveModelsUrl: '留空則預設為 baseUrl + /v1/models', apiKeyLocal: 'API Key（只限本機）', allowedModels: '允許模型', selectedModels: '已選 {selected}／全部 {total}', modelHint: '勾選後會出現在各任務下拉清單', noModels: '尚未有模型，可以先擷取或手動新增。', manualModel: '手動新增模型，例如 gpt-4.1-mini 或 provider:model', addModel: '新增模型', manualAdded: '手動新增', providerHint: '可設定 baseUrl / key，擷取模型後勾選允許清單；default 仍作為全局回退。', taskMapping: 'AI Task → 模型映射', taskHint: '各任務只顯示允許模型；如目前值不在允許清單中，會暫時保留顯示。', providerIdPrompt: '請輸入 provider ID（英文、數字、- 或 _）', providerExists: '此 provider ID 已存在', taskWord: '查詞 / 單詞分析', taskSentence: '造句檢查', taskQa: '問答 AI 校對', taskArticle: '文章詳解', taskCleanup: '文章 AI 清理', taskExamples: '例句產生', taskOcr: 'OCR / 視覺', taskAssistant: 'AI 助手'
        ,noAvailable: '沒有可用選項', voicesLoaded: '已載入，共 {count} 個聲音', loadFailed: '載入失敗', loadFailedMessage: '載入失敗：{message}', noVoice: '沒有可用的聲音可試聽', playbackFailed: '播放失敗，已在 Console 輸出測試 URL，請檢查回應格式及 voice 代碼。', fallbackVoice: '提示：該聲音可能不受後端支援，已使用預設備用聲音試聽。', assistantEntryTitle: '右下角浮窗入口', streamTitle: '串流回應可減少等待'
    },
    common: {
        increase: '增加',
        decrease: '減少',
        noBooks: '沒有可用的生字簿。',
        optionsTitle: '選項設定',
        cancel: '取消',
        confirm: '確定'
    },
    errors: {
        urlInvalid: '網址無效',
        urlSchemeOnly: '僅支援 http/https',
        urlFetchFailed: '無法擷取此網址內容（可能被目標站點或網路限制）',
        extractEndpointMissing: '尚未設定文章擷取服務端點',
        extractUrlFailed: '無法建立文章擷取網址',
        extractNoContent: '擷取結果缺少正文內容',
        missingSourceId: '缺少來源代碼',
        feedEndpointMissing: '未設定新聞來源端點',
        missingArticleUrl: '缺少文章網址',
        extractFallbackFailed: '{first}；改用設定的抽取端點也失敗：{second}',
        directFetchBlocked: '目標站點禁止直抓或網路受限。請允許第三方轉換，或貼上全文/HTML。',
        syncEndpointMissing: '尚未設定同步端點（ai-config.js 的 SYNC.endpoint）',
        passcodeRequired: '請輸入通行碼',
        cannotReachSync: '無法連線到同步服務',
        passcodeWrong: '通行碼錯誤',
        loginFailed: '登入失敗（{status}）',
        serverNoUser: '伺服器未返回使用者',
        newPasscodeTooShort: '新通行碼至少 6 位',
        loginExpired: '登入已失效，請重新登入',
        changeFailed: '修改失敗（{status}）',
        recoveryRequired: '請填寫使用者代號與恢復碼',
        recoveryWrong: '使用者代號或恢復碼錯誤',
        resetFailed: '重置失敗（{status}）',
        unauthorized: '未授權，請重新登入',
        cloudReadFailed: '讀取雲端失敗（{status}）',
        cloudWriteFailed: '寫入雲端失敗（{status}）',
        syncConflict: '同步衝突重試仍失敗',
        modelListFailed: '模型清單抓取失敗',
        modelListCancelled: '模型清單抓取已取消',
        modelListBadFormat: '模型清單回傳格式無法解析',
        modelsUrlMissing: '尚未設定可用的 modelsUrl',
        modelListEmpty: '模型清單為空',
        modelNotAllowed: '{value}（目前值，未在允許清單）',
        wordbookNotFound: '找不到 ID 為 {id} 的生詞本，無法新增單字。',
        articleMetaInvalid: 'getOrCreateArticleWordbook 需要有效的 articleMetaInput（至少包含 title 與 sourceType）',
        untitledArticle: '未命名文章'
    },
    vocabulary: {
        articleSourceLabel: '文章來源',
        backToArticle: '回文章',
        wordCountSuffix: '({count}個單詞)',
        importDetectedParam: '偵測到參數請求導入預設生字簿「{name}」。是否現在導入？',
        urlBook: 'URL 生字簿',
        importDetectedUrl: '偵測到外部生字簿 URL：\n{url}\n是否導入？',
        sourceArticle: '來源：文章詳解',
        sourceArticleUrl: '來源：文章詳解（網頁 / 新聞）',
        sourceArticleFile: '來源：文章詳解（文章庫 / 檔案）',
        sourceArticleOcr: '來源：文章詳解（圖片 OCR）',
        openOrigin: '開啟原文',
        missingDataSummary: '共 <strong>{total}</strong> 條，其中缺失資料（音標為 n/a 或空白、或中文釋義缺失）的有 <strong>{missing}</strong> 條。',
        analyzingProgress: '正在分析：{word}（{done}/{total}）',
        analysisFailedShort: '分析失敗',
        processDone: '處理完成！',
        pageSub: '選擇生字簿後可朗讀、編輯、匯出，亦可直接進入默書與學習。',
        loadPresetListFailed: '無法讀取預設生字簿清單，請稍後再試。',
        noBooksImported: '沒有匯入任何生字簿。',
        presetNotFound: '未找到 ID 為「{id}」的預設生字簿。',
        invalidUrlParam: 'URL 參數無效，無法匯入：{url}',
        importDone: '匯入完成！\n\n{summary}',
        booksPanel: '全部生字簿',
        editShort: '編輯',
        deleteShort: '刪除',
        exportShort: '匯出',
        mergeShort: '合併',
        completeMissingShort: '補全資料',
        filterLabel: '篩選生字',
        filterPlaceholder: '篩選生字或釋義',
        filterEmpty: '沒有符合「{keyword}」的生字',
        filterCount: '符合 {shown} / {total}',
        totalCount: '共 {count} 個生字',
        wordCount: '{count} 個生字',
        playWord: '播放生字與釋義',
        myBooks: '我的生字簿',
        addBook: '新增生字簿',
        importBook: '匯入生字簿',
        selectBook: '請選擇一個生字簿',
        completeMissing: '補全缺失資料',
        mergeBooks: '合併生字簿',
        exportBook: '匯出生字簿',
        editWords: '編輯生字',
        deleteBook: '刪除生字簿',
        chooseOrCreate: '請從左側選擇或建立一個生字簿',
        noBooksImport: '尚未有生字簿。{link}，或按上方「匯入生字簿」。',
        importHere: '按此匯入',
        emptyBook: '這個生字簿是空的，按右上角鉛筆按鈕新增生字。'
        ,newBookTitle: '新增生字簿'
        ,editBookTitle: '編輯生字簿 - {name}'
        ,bookName: '生字簿名稱'
        ,bookNamePlaceholder: '例如：雅思核心詞彙'
        ,bulkWords: '批量新增生字（每行一個）'
        ,bulkWordsPlaceholder: '可只輸入英文生字，例如：\napple\nbanana\ncherry\n系統會自動補全音標及釋義。'
        ,create: '建立'
        ,sourceUrl: '來源網址（可選）'
        ,sourceUrlHint: '填寫網址後，「開啟原文」會使用此連結；留空則不顯示。'
        ,wordFormat: '生字內容（格式：生字#中文@音標）'
        ,wordFormatHint: '只有英文生字的行會嘗試自動補全音標及釋義。'
        ,saveChanges: '儲存更改'
        ,deleteConfirm: '確定要永久刪除生字簿「{name}」嗎？此操作無法撤回。'
        ,exportNoActive: '沒有目前生字簿可以匯出。'
        ,exported: '生字簿「{name}」已匯出。'
        ,mergeNeedTwo: '至少需要兩個生字簿才能合併。'
        ,mergeTitle: '合併生字簿'
        ,newMergedName: '新生字簿名稱'
        ,mergedNamePlaceholder: '例如：我的合輯'
        ,dedupeHint: '重複生字會自動移除。'
        ,keepSourcesHint: '不勾選則保留原生字簿。'
        ,merge: '合併'
        ,duplicateName: '已存在名為「{name}」的生字簿，請使用其他名稱。'
        ,mergeSuccess: '成功將 {count} 個生字簿合併為「{name}」{suffix}！'
        ,sourcesDeleted: '（已刪除來源生字簿）'
        ,nameRequired: '生字簿名稱不能為空！'
        ,processing: '處理中...'
        ,completeMissingTitle: '補全缺失資料'
        ,completeMissingHint: '片語會優先使用已儲存的上下文補全中文釋義，並補上整體或逐詞 IPA。'
        ,dedupe: '合併去重'
        ,startAction: '開始'
        ,stopAction: '停止'
        ,completing: '正在補全：{word}（{done}/{total}）'
        ,completeResult: '完成：更新 {updated} 項，略過 {skipped} 項。'
        ,dedupeResult: '去重完成：移除 {removed} 項重複記錄。'
        ,dedupeFailed: '去重失敗，請稍後再試。'
        ,beforeStart: '開始之前'
        ,cloudAccountHint: '已有雲端帳戶？可直接登入並同步現有生字簿。'
        ,later: '稍後'
        ,login: '登入'
        ,importTitle: '匯入生字簿'
        ,loadingPresets: '正在載入預設生字簿...'
        ,noPresets: '找不到可用的預設生字簿。'
        ,presetSection: '從預設列表選擇'
        ,urlSection: '從 URL 匯入'
        ,urlLabel: '生字簿 URL'
        ,fileSection: '從檔案匯入'
        ,fileLabel: '選擇 JSON 檔案'
        ,loginSyncHint: '已有帳戶？登入後可同步雲端生字簿，無需再次匯入。'
        ,importSelected: '匯入已選項目'
        ,loadFailed: '載入失敗，請稍後再試。'
        ,processingSource: '正在處理：{name}...'
        ,loadingSourceFailed: '無法載入：{name}'
        ,invalidFile: '檔案格式無效'
        ,readFileFailed: '讀取檔案失敗'
        ,unknownSource: '未知的來源類型'
        ,invalidSourceData: '資料來源 {name} 格式不正確。'
        ,skipped: '已略過：{name}'
        ,parsing: '正在解析：{line}（{current}/{total}）'
        ,overwritten: '已覆蓋：{name}'
        ,imported: '已匯入：{name}'
        ,importFailed: '匯入失敗：{name}'
        ,overwriteConfirm: '生字簿「{name}」已存在，要覆蓋嗎？'
        ,invalidUrl: '「{url}」不是有效的 URL。'
        ,selectSource: '請至少選擇一個預設生字簿、提供 URL 或選擇檔案。'
        ,importing: '正在匯入...'
        ,importComplete: '匯入完成！\n\n{summary}'
        ,importNoChanges: '匯入完成，但沒有任何更改。'
        ,importProcessFailed: '匯入期間發生錯誤，請查看控制台記錄。'
        ,currentBookLabel: '目前生字簿：', missingSummary: '共 {total} 條，其中缺失資料（音標為 n/a 或空白，或中文釋義缺失）的有 {missing} 條。', defaultBookName: '生字簿', nothingToAdd: '沒有可加入的文字。', existsInBook: '「{word}」已存在於《{book}》。', addedToBook: '已加入「{word}」到《{book}》。'
    },
    dictation: {
        pageSub: '裝置朗讀單詞，孩子在紙上書寫；可隨時暫停、重播、跳轉。',
        playerAria: '默書進行中',
        statePlaying: '播放中',
        statePaused: '已暫停',
        stageListening: '正在朗讀，請在紙上寫下單詞',
        stagePaused: '已暫停，休息一下再繼續',
        stageHint: '聽不清楚可以按「重播」，或按「上一個」重聽。',
        modeAria: '練習方式',
        modePaper: '紙上默書',
        modePaperDesc: '只聽聲音，在紙上書寫（推薦）',
        modeTyped: '跟打練習',
        modeTypedDesc: '聽完後在下方輸入框拼寫並檢查',
        advanced: '進階設定',
        loopHint: '播完最後一個後回到第一個',
        shuffleHint: '打亂單詞順序後才開始',
        startHint: '開始後會先朗讀第一個單詞，請準備好紙和筆。',
        previousShort: '上一個',
        nextShort: '下一個',
        finish: '結束',
        doneTitle: '默書完成',
        doneDesc: '全部單詞都播放完畢，檢查一下紙上的拼寫吧。',
        doneDescCount: '全部 {count} 個單詞都播放完畢，檢查一下紙上的拼寫吧。',
        statWords: '單詞',
        statRepeat: '每詞次數',
        statTime: '用時',
        again: '再來一遍',
        backToSettings: '返回設定',
        summaryRepeat: '每詞 {count} 次',
        summaryInterval: '間隔 {seconds} 秒',
        summaryMandarin: '朗讀普通話釋義',
        summaryCantonese: '朗讀粵語釋義',
        summaryLoop: '循環播放',
        summaryShuffle: '隨機順序',
        statusCurrent: '正在默書',
        statusDone: '已播放',
        statusPending: '待播放',
        title: '默書模式',
        settings: '設定',
        selectBook: '選擇生字簿：',
        repeat: '重複：',
        repeatSlider: '滑動設定重複次數',
        interval: '生字間隔：',
        intervalSlider: '滑動設定生字間隔',
        chinese: '中文：',
        mandarinShort: '普',
        cantoneseShort: '粵',
        loop: '循環模式：',
        shuffle: '隨機播放：',
        listenOnly: '只聽不練：',
        start: '開始默書',
        stop: '停止',
        pause: '暫停',
        resume: '繼續',
        replay: '重播',
        previous: '上一個',
        next: '下一個',
        aiGrade: 'AI 批改手寫',
        practice: '默書練習',
        inputPlaceholder: '請輸入聽到的生字',
        check: '檢查',
        selectBookAlert: '請先選擇一個包含生字的生字簿！',
        stopped: '已停止',
        completed: '默書完成',
        startFirst: '請先開始默書！',
        correct: '正確！',
        incorrect: '錯誤！正確答案是：{answer}',
        noPhonetic: '暫無音標',
        wordList: '生字列表',
        showWordInfo: '顯示生字資料',
        fieldsLabel: '列表顯示內容', fieldIndex: '序號', fieldStatus: '狀態', fieldWord: '單詞', fieldPhonetic: '音標', fieldMeaning: '釋義',
        listHiddenHint: '已隱藏單詞列表，只保留播放控制',
        expandWordList: '展開生字列表',
        collapseWordList: '收起生字列表',
        collapsePlayer: '收起播放器',
        expandPlayer: '展開播放器',
        backToDictation: '返回默書頁面',
        previousTitle: '上一個生字',
        nextTitle: '下一個生字',
        replayTitle: '重播目前生字',
        restoreSession: '偵測到未完成的默書會話：\n開始時間：{startTime}\n進度：{current}/{total}\n\n是否繼續之前的會話？',
        restoreTitle: '繼續上次默書',
        restoreConfirm: '繼續默書',
        restoreDiscard: '放棄並重新開始'
    },
    dictationGrader: {
        correctShort: '正確',
        wrongWithHint: '錯誤 → {hints}',
        suggestionLabel: '建議：{text}',
        title: 'AI 批改手寫（OCR）',
        historyTitle: '批改歷史',
        resultTitle: '批改結果',
        emptyHistory: '暫無歷史記錄。',
        meta: '模型：{model} · 圖片：{images} · 詞表：{words}',
        view: '查看',
        delete: '刪除',
        clearAll: '清空全部',
        confirmClear: '確定清空全部歷史？此操作不可撤回。',
        confirmDelete: '確定刪除此記錄？',
        takePhoto: '拍照',
        gallery: '從相簿選擇',
        includeMeaning: '對照中文意思（如有）',
        strictCase: '嚴格區分大小寫',
        localMode: 'OCR + 本機比對',
        aiMode: '直接交由 AI 批改',
        promptPlaceholder: '自訂 AI 批改提示詞',
        run: '識別並批改',
        save: '儲存結果',
        history: '查看歷史',
        copy: '複製 Markdown',
        downloadCsv: '下載 CSV',
        initialStatus: '請上載或拍照後按「識別並批改」',
        selectedImages: '已選擇 {count} 張圖片',
        noImages: '尚未選擇圖片',
        uploadFirst: '請先上載或拍照',
        processing: '正在識別及批改...',
        completed: '批改完成（AI）',
        failed: '處理失敗：{message}',
        noResult: '沒有可儲存的結果',
        saved: '已儲存：{time}',
        copied: '已複製 Markdown 到剪貼簿',
        copyFailed: '複製失敗，請手動選取',
        currentWords: '目前對照生字 {count} 個',
        standardAnswer: '標準答案', writing: '書寫內容', chineseReference: '中文（參考）', result: '結果',
        correct: '正確', wrongSuggestion: '錯誤 → 建議：{suggestion}', viewRecord: '查看記錄：{time}'
    },
    menu: {
        syncNow: '立即同步',
        login: '登入',
        changePasscode: '更改通行碼',
        logout: '登出',
        globalSettings: '全局設定',
        gradingHistory: '默書批改歷史',
        assistantSessions: 'AI 會話',
        backupRestore: '備份與還原'
    },
    ocr: {
        recognizeFailedTag: '[識別失敗] {message}',
        progressSummary: '{done}/{total} 完成（成功 {success}，失敗 {failed}，取消 {cancelled}）',
        singleRetryHeader: '--- 單張重試：{name} ---',
        title: '圖片文字識別（OCR）', upload: '上載圖片：', preferCamera: '優先使用相機', openCamera: '開啟相機', clear: '清除', clearTitle: '清除已加入的圖片及結果', stop: '停止', run: '識別文字', notStarted: '尚未開始', advanced: '進階選項', prompt: '補充要求：', promptPlaceholder: '例如：只擷取右下角藍色對話框文字', presets: '常用範本：', presetDefault: '常用範本...', model: 'OCR 模型：', merge: '多張圖片合併為一段輸出', capture: '拍照', closeCamera: '關閉相機', dropAria: '拖放或貼上圖片以加入 OCR', pasteHint: '提示：在此區域按 Ctrl+V 或 ⌘+V 可直接貼上截圖，也可拖放圖片。', result: '識別結果', added: '已加入 {count} 張圖片', addFailed: '加入圖片失敗：{message}', readFailed: '讀取圖片失敗：{message}', duplicateSkipped: '已略過重複圖片', skippedDuplicates: '已略過 {count} 張重複圖片', captureFailed: '拍照失敗：{message}', uploadFirst: '請先上載圖片或拍照', taskRunning: '任務進行中，請先停止或等待完成', recognizing: '正在識別 {done}/{total} 張圖片...', pending: '待處理', processing: '處理中', done: '完成', cancelled: '已取消', failed: '失敗', completedSummary: '識別完成：{total} 張（成功 {success}，失敗 {failed}，取消 {cancelled}）', completed: '完成！', recognizeFailed: '識別失敗：{message}', stopped: '已停止，未完成的會標記為取消', retry: '按此重試', retryDone: '重試完成', retryFailed: '重試失敗：{message}', pasteFailed: '貼上圖片失敗：{message}', cameraUnsupported: '此瀏覽器不支援直接開啟相機，將改用「拍照上載」。', insecureCamera: '目前不是安全來源（需要 HTTPS 或 localhost），瀏覽器已阻止相機存取。將改用「拍照上載」。', insecureCameraShort: '目前不是安全來源，瀏覽器可能阻止相機。建議使用 HTTPS 或 localhost。', cameraAccessFailed: '無法存取相機：{message}'
        ,presetHint: '選擇範本會附加到提示詞', displayMode: '顯示模式', plainText: '純文字', markdownPreview: 'Markdown 預覽', resultPlaceholder: '識別後的文字會顯示在此處', configureModel: '請先到全局設定配置 provider 及模型', presetBluePrompt: '只擷取圖片中右下角藍色對話框的所有文字，按原有換行輸出；忽略其他區域及 UI 元素。', presetBlueLabel: '只擷取：右下角藍色對話框', presetEnglishPrompt: '只輸出圖片中的英文及阿拉伯數字，保留原始換行；忽略圖示、按鈕、介面元素及背景雜訊。', presetEnglishLabel: '只擷取：英文及數字', presetBodyPrompt: '請將正文完整轉寫為純文字，保留原始換行及標點；刪除頁碼、分隔線、圖示及介面文字。', presetBodyLabel: '正文轉寫，移除 UI／雜訊', presetQuizPrompt: '如屬題目圖片，只擷取題幹及選項文字，依次以 A)、B)、C)、D) 標示；不要輸出解析或多餘內容。', presetQuizLabel: '試題模式：題幹＋選項', presetMarkdownPrompt: '輸出為 Markdown 清單：每個段落作為一個項目，如有小標題請使用二級標題。', presetMarkdownLabel: '輸出格式：Markdown 清單', presetDictationPrompt: '這是一張默書生字的相片。請逐行擷取學生書寫的英文單字或片語，保留順序及原始大小寫。然後檢查每行拼寫是否正確，如有中文意思，也檢查中文書寫是否正確：正確請在行末標註（正確）；錯誤請標註（錯→建議：correct）。只輸出純文字清單，不要翻譯或加入多餘解釋。', presetDictationLabel: '小學生默書生字：檢查拼寫'
        ,imageHeader: '--- 圖片 {current}/{total}：{name} ---'
    },
    quiz: {
        progressInitial: '題目 0/0',
        scoreInitial: '得分：0/0',
        leaveConfirmation: '測驗正在進行中，確定要離開嗎？',
        title: '隨堂測驗',
        settings: '測驗設定',
        selectBook: '選擇生字簿：',
        count: '題目數量：',
        countSlider: '滑動設定題目數量',
        type: '測驗類型：',
        typeMeaning: '看英文選中文',
        typeWord: '看中文選英文',
        typePhonetic: '看音標選生字',
        typeMixed: '混合模式',
        start: '開始測驗',
        stop: '結束測驗',
        next: '下一題',
        completed: '測驗完成！',
        restart: '重新測驗',
        needFourWords: '請先選擇一個至少包含 4 個生字的生字簿開始測驗！',
        stopped: '測驗已停止！',
        noMeaning: '（無中文意思）',
        askMeaning: '「{word}」的中文意思是？',
        askWord: '「{meaning}」對應的英文生字是？',
        askPhonetic: '音標「{phonetic}」對應的生字是？',
        progress: '題目 {current}/{total}',
        score: '得分：{score}/{total}',
        excellent: '優秀！你對這些生字掌握得很好！',
        good: '良好！繼續保持，再接再厲！',
        pass: '及格！建議多溫習這些生字。',
        improve: '需要加強！請多花時間學習這些生字。'
    },
    learning: {
        pageSub: '逐詞查看音標、釋義與例句，亦可聽發音、做造句練習。',
        prevWord: '上一個',
        nextWord: '下一個',
        wordPosition: '第 {current} / {total} 個',
        selectWord: '請先選擇一個單詞！',
        enterSentence: '請輸入一個例句！',
        mustContainWord: '你的例句必須包含單詞「{word}」。',
        checking: '正在檢查...',
        sentenceCorrect: '很好！你的例句正確。',
        sentenceHasIssues: '你的例句有一些問題。',
        suggestion: '建議：',
        requestFailed: '檢查例句失敗，請檢查 API Key 或網絡連線後再試。',
        checkFailed: '檢查失敗。',
        title: '學習模式',
        selectBook: '選擇生字簿：',
        selectWordTitle: '選擇生字',
        selectBookFirst: '請先從上方選擇生字簿',
        currentBookEmpty: '目前生字簿為空',
        selectWordOption: '請選擇生字',
        noMeaning: '（無中文意思）',
        speakWord: '朗讀生字',
        examples: '例句',
        generateExamples: '產生 AI 例句',
        generating: '產生中...',
        generateFailed: '產生例句失敗，請檢查 API Key 或網絡連線後再試。',
        noExamples: '尚未有例句，按「產生 AI 例句」按鈕建立例句。',
        sentencePractice: '造句練習',
        sentencePlaceholder: '請使用此生字造句',
        check: '檢查'
    },
    article: {
        newsImportBtn: '導入',
        fetchShort: '擷取',
        fetching: '擷取中…',
        directFetchFailed: '直抓失敗或受 CORS 限制',
        newsSourcesMissing: '尚未設定新聞來源（請在 ai-config.js → ARTICLE_IMPORT.SOURCES 加入來源）',
        newsEmptySource: '此來源暫無可用文章',
        newsLoadFailed: '載入失敗：{message}',
        newsUnknownError: '未知錯誤',
        newsOrigin: '原文',
        articleContentMissing: '未取得文章內容',
        readingFull: '全文',
        analysisFailedInline: '分析失敗',
        retryingProgress: '重試中... ({done}/{total})',
        title: '文章詳解', inputTitle: '輸入文章', historyRead: '讀取歷史記錄', historyManage: '管理記錄', historyManageTitle: '管理閱讀記錄', historyDelete: '刪除記錄', historyDeleteTitle: '刪除選中的歷史記錄', inputPlaceholder: '在這裏輸入或貼上你想分析的文章...', analyze: '分析文章', import: '匯入...', importTitle: '從網址或圖片匯入文章', retryFailed: '重試失敗段落', clear: '清除重寫', library: '從文章庫選取', compactHint: '目前文章詳解採用精簡模式：只輸出中文翻譯。', readingControls: '朗讀控制', read: '朗讀文章', stopReading: '停止朗讀', downloadAudio: '下載語音', mode: '模式：', full: '全文', paragraph: '段落', sentence: '句子', dimming: '淡化強度：', dimmingTitle: '調整非目前句子的淡化程度', repeat: '重複：', repeatTitle: '設定段落／句子朗讀的重複次數', repeatSlider: '滑動設定重複次數', speed: '語速：', previousSentence: '上一句', nextSentence: '下一句', previousParagraph: '上一段', nextParagraph: '下一段', result: '分析結果', maskAria: '翻譯遮罩', maskLabel: '迷霧', maskTitle: '翻譯遮罩：預設開啟；滑鼠移入／按住顯示', sourceEmpty: '來源：—', sourcePrefix: '來源：', sourceUrl: '網頁／新聞', sourceFile: '文章庫／檔案', sourceOcr: '圖片 OCR', sourcePaste: '貼上文字', openSource: '開啟原文', initialHint: '請先輸入文章並按分析按鈕。', untitled: '未命名文章', importModal: '匯入文章', importUrl: '網址匯入', importNews: '新聞來源', importOcr: '圖片 OCR', importQa: '問答集', pasteUrl: '貼上網址', fetch: '擷取', chooseFile: '選擇檔案', chooseFileTitle: '從本機檔案匯入 .md/.txt', sourceList: '來源列表', cleanupOptions: '清理選項', aiCleanup: 'AI 清理內容（更適合閱讀）', keepImages: '保留圖片', autoApply: '擷取後自動套用', skipThirdParty: '略過第三方轉換', cleanupModel: '清理模型', configureModel: '請先到全局設定配置 provider 及模型', dropTextFile: '拖放 .md / .txt 到此，或聚焦後按 Ctrl+V 貼上全文', beforeCleanup: '清理前', afterCleanup: '清理後', applyInput: '套用到輸入框', chooseImages: '選擇圖片', preferCamera: '優先使用相機', addImages: '新增圖片', clearImages: '清空', ocrModel: 'OCR 模型', dropImages: '拖放圖片到此，或在此視窗貼上截圖', prompt: '提示詞', promptPlaceholder: '例如：只輸出圖片中的文章正文，保留原始換行；忽略 UI 元素及雜訊', extractImageText: '擷取圖片文字', mergeOutput: '合併輸出', ocrPreview: 'OCR 結果預覽', ocrHint: '使用 AI 視覺模型擷取圖片中的文字，保留原始換行及標點。', remove: '移除', selectImagesFirst: '請先選擇圖片', extracting: '擷取中...', imageNumber: '圖片 {number}', ocrFailed: 'OCR 失敗：{message}', selectQa: '選擇問答集', importAsArticle: '匯入為文章', preview: '預覽', preset: '（預設）', selectQaFirst: '請先選擇問答集', loadQaFailed: '載入問答集失敗', qaDefault: '問答集', importHint: '將透過 r.jina.ai 嘗試擷取閱讀版內容；如失敗則改用簡易擷取。', enterArticle: '請輸入要分析的文章！', analyzing: '分析中...', preparing: '準備中...', analyzingParagraph: '正在分析第 {number} 段...', completedParagraphs: '已完成 {count} 段分析', retryParagraph: '重試本段', elapsed: '需時', cancelled: '已取消這次分析。', analysisFailed: '分析失敗！請檢查 API Key 或網絡連線後再試。', invalidArticle: '請輸入有效的文章內容！', invalidResponse: 'API 傳回的資料格式不完整。', noHistory: '尚未有閱讀記錄。', unknownTime: '未記錄時間', analyzed: '已分析', notAnalyzed: '未分析', load: '載入', delete: '刪除', clearAll: '清空全部', historyManager: '閱讀記錄管理', confirmClearHistory: '確定清空全部閱讀記錄？此操作無法復原。', confirmDeleteHistory: '確定刪除此閱讀記錄？', selectHistory: '請先選擇一個歷史記錄！', noContent: '沒有內容', noLibraryMatch: '沒有符合條件的文章。', loadingLibrary: '正在載入文章列表...', emptyLibrary: '文章庫是空的。', loadLibraryFailed: '載入文章列表失敗。', allCategories: '全部分類', uncategorized: '未分類', articleCount: '{count} 篇', loadArticleFailed: '載入文章失敗！'
        ,noArticleRecord: '找不到對應的文章記錄，請先在文章詳解中載入或分析一篇文章。'
        ,readerDrag: '拖動'
        ,pause: '暫停'
        ,resume: '繼續'
        ,englishOnly: '僅顯示英文'
        ,followScroll: '跟隨朗讀滾動'
        ,finishReading: '結束朗讀'
        ,enterUrl: '請輸入網址'
        ,missingUrl: '缺少文章網址'
        ,fetchFailed: '擷取失敗：{message}'
        ,articleImportFailed: '匯入失敗：{message}'
        ,enterArticleToRead: '請先輸入要朗讀的文章！'
        ,downloadAudioFailed: '下載音訊失敗，可能是文字過長或網絡問題。請嘗試切換為句子／段落模式下載。'
        ,analysisRecordMissing: '這篇文章的分析記錄已刪除，無法自動還原原文。請重新匯入或貼上文章內容後再分析。'
        ,doneStatus: '完成', failedStatus: '解析失敗', refresh: '重新擷取', refreshing: '重新擷取中...', sentenceAnalysis: '句子解析', sentenceNoTranslation: '（本句暫無中文譯文）', processing: '處理中…', cleaning: 'AI 清洗中…', cleaningProgress: 'AI 清洗中…（{done}/{total}）', fetching: '擷取中…', cleanupTruncated: '內容較長，AI 清洗已達模型輸出上限，結果可能少了尾段；建議分段導入。', extractTruncated: '內容較長，AI 擷取已達模型輸出上限，結果可能少了尾段；建議分段導入。', sourcesFallbackHint: '新聞來源端點沒有回應，目前顯示的是 ai-config.js 裡設定的後備來源清單，可能與服務端實際支援的來源不一致。', collapse: '收合', close: '關閉', closeWindow: '關閉視窗', details: '詳解', detailsLoading: '詳解載入中...', loading: '載入中...', loadingDetails: '正在載入詳解...', analyzeSelection: '解析選中內容', selectPhraseHint: '選取句中片語後按一下', collapseArea: '按此區收合', collapseAreaAria: '按右側空白區可收合', selectPhraseFirst: '請先在該句中選取片語', analyzingSelection: '解析中...', phraseLabel: '片語：', usageLabel: '用法：', roleLabel: '作用：', meaningLabel: '意思：', pronunciation: '發音', analyzePhrase: '解析片語', analyzeOtherPhrase: '自訂片語...', phrasePrompt: '輸入要解析的片語', analysisRetry: '解析失敗，請稍後再試', analysisRetryShort: '解析失敗，請稍後重試', noAnalysisData: '找不到分析資料。', retry: '重試', retrying: '重試中...', addToWordbook: '加入生字簿', addSelectedToWordbook: '加入生字簿（選中）', selectWordOrPhrase: '請先在該句中選取字詞或片語', wordAnalysisFailed: '解析失敗。'
    },
    qa: {
        setNameLabel: '問答集名稱',
        checkShort: 'AI 校驗',
        progressInitial: '第 1 題 / 共 10 題',
        puncNoTerminator: '句末缺少終止符',
        puncNeedsFix: '標點/格式需要修正',
        apiRequestFailed: 'AI API 請求失敗：{code}{message}',
        aiBadFormat: 'AI 回應格式錯誤',
        aiEmptyResponse: 'AI 回應為空',
        checkTimeout: '校對超時：Q{qid}',
        aiUnavailableShort: 'AI 校對暫不可用，請稍後再試',
        answerCorrect: '答案正確',
        checkAccuracy: '請檢查答案的準確性',
        inconsistentWithReference: '與參考答案不一致',
        missingPunctuation: "缺少標點 '{char}'",
        extraPunctuation: "多餘標點 '{char}'",
        shouldCapitalizeStart: '句首應使用大寫字母',
        commaAfterYesNoShort: '"Yes/No" 後建議加逗號',
        pronounIShouldCapitalize: '代詞 I 應大寫',
        noLeadingSpaceBeforePunct: '標點前不應有空格',
        emptyOrInvalidAnswer: '未作答或內容無效（需英文作答）',
        answerInEnglish: '請用英文直接回答問題',
        answerKeyPoints: '參考參考答案的要點作答',
        notAnsweringQuestion: '未直接回應題目',
        addKeyInfo: '補充關鍵資訊：{items}',
        answerMainPoint: '請直接回答題目重點',
        answerEchoesOnly: '答案偏向附和/評述，未回應題目要點',
        notCoveringKeyInfo: '未覆蓋標準答案的關鍵資訊',
        insufficientKeyInfo: '未直接回應題目或關鍵資訊不足',
        pdfCtorFailed: 'jsPDF 建構函數呼叫失敗：{message}',
        pdfCtorMissing: 'jsPDF 載入失敗：未找到建構函數',
        pdfLibLoadFailed: '無法載入 jsPDF 庫',
        noValidPairs: '沒有找到有效的問答對',
        qidShouldStartAtOne: '問題編號應該從 1 開始連續編號',
        duplicateQid: '發現重複的問題編號',
        qidQuestionEmpty: 'Q{qid} 的問題內容不能為空',
        qidAnswerEmpty: 'A{qid} 的答案內容不能為空',
        dragToSort: '拖曳排序',
        editQuestionAria: '編輯問題 Q{qid}',
        editAnswerAria: '編輯答案 A{qid}',
        setNameRequired: '問答集名稱不能為空',
        needAtLeastOnePair: '至少需要一個問答對',
        pairFormatError: '問答對格式錯誤：{errors}',
        createdByUser: '用戶建立',
        createSetFailed: '儲存問答集失敗',
        copySuffix: '（複本）',
        uncategorized: '未分類',
        presetDescription: '預置問答集',
        invalidSetData: '問答集數據格式無效',
        saveSetFailed: '儲存問答集失敗：{message}',
        setNotFound: '問答集不存在',
        deleteSetFailed: '刪除問答集失敗：{message}',
        invalidImportFormat: '導入的問答集格式無效',
        confirmOverwriteSet: '問答集「{name}」已存在，是否覆蓋？',
        importSetFailed: '導入問答集失敗：{message}',
        unsupportedExportFormat: '不支援的導出格式',
        exportSetFailed: '導出問答集失敗：{message}',
        trainerSetMissing: '找不到指定的問答集',
        trainingStartFailed: '訓練啟動失敗：{message}',
        noActiveSession: '沒有活動的訓練會話',
        invalidQuestionIndex: '無效的問題索引',
        invalidTrainingMode: '無效的訓練模式',
        invalidSubmitMode: '無效的提交模式',
        checkingDetail: '分析答案準確性和語法正確性',
        checkDoneShort: '校對完成',
        aiCheckQuestionDone: '第 {number} 題 AI 校驗完成！',
        aiCheckQuestionFailed: '第 {number} 題校驗失敗：{message}',
        aiCheckingQuestion: '正在 AI 校驗第 {number} 題...',
        referenceShort: '參考',
        totalQuestionsLabel: '題目總數',
        presetReadonly: '預置問答集無法直接覆寫，請使用「套用範本」建立副本。',
        cannotLoadForEdit: '無法載入選定的問答集進行編輯。',
        loadForEditFailed: '載入問答集失敗，無法進行編輯。',
        selectSetFirst: '請先選擇要套用的問答集。',
        templateApplied: '已套用「{name}」作為範本。',
        templateApplyFailed: '無法套用範本，請稍後再試。',
        updateFailed: '更新失敗：{message}',
        startTrainingFailed: '無法開始訓練：{message}',
        exportOptionsTitle: '問答集導出選項',
        exportOptionsDescription: '選擇導出格式和設定，適合不同的使用場景',
        exportType: '導出類型',
        exportTypeDesc: '選擇導出的用途',
        exportHandwritingLabel: '手寫默寫版',
        exportHandwritingDesc: '適合打印後手寫練習',
        exportJsonLabel: 'JSON 數據',
        exportJsonDesc: '原始數據格式，便於分享和備份',
        shuffleOption: '隨機打亂題目順序',
        shuffleOptionDesc: '避免記憶順序，提高練習效果',
        includeAnswers: '包含標準答案',
        includeAnswersDesc: '在 PDF 中顯示答案供對照',
        answerLines: '答題行數',
        answerLinesDesc: '每道題目的答題空間',
        answerLinesOne: '一行（適合短答案）',
        answerLinesTwo: '兩行（適合長答案）',
        perPageQuestions: '每頁題目數量',
        perPageQuestionsDesc: '控制每頁顯示的題目數量',
        answerPlaceholderShort: '輸入答案...',
        answerInputMissing: '找不到答案輸入框',
        submitAnswerFailed: '提交答案失敗：{message}',
        questionInfoUnavailable: '目前無法取得題目資訊',
        feedbackFailed: 'AI 校對失敗，請稍後再試。',
        prevQuestionFailed: '無法切換到上一題：{message}',
        nextQuestionFailed: '無法切換到下一題：{message}',
        trainingDoneGenerating: '訓練完成！正在生成 AI 校對報告...',
        finishTrainingFailed: '完成訓練失敗：{message}',
        presetCannotDelete: '無法刪除預置問答集',
        confirmDeleteSetNamed: '確定要刪除問答集「{name}」嗎？此操作無法復原。',
        formElementMissing: '找不到表單元素',
        saveFailed: '保存失敗：{message}',
        answeredSaved: '已保存',
        answeredNot: '未回答',
        punctuationEndMissing: '句末缺少標點',
        commaAfterYesNo: '"Yes/No" 後建議加逗號',
        avoidDoubleSpace: '請避免連續空格',
        noCheckableResults: '沒有可校對的訓練結果',
        aiCheckDone: 'AI 校對完成！',
        aiCheckDoneCount: 'AI 校對完成！處理了 {count} 個答案',
        aiCheckInvalid: 'AI 校對返回無效結果',
        aiCheckFailedWith: 'AI 校對失敗：{message}',
        aiCheckFailed: 'AI 校對失敗',
        checkSummaryTitle: 'AI 校對總結',
        incorrectCount: '錯題',
        incorrectOverview: '錯題總覽（{count}）',
        yourAnswerLabel: '您的答案',
        referenceAnswerLabel: '參考答案',
        issueTagPunctuation: '【標點/格式】{text}',
        noExportableResults: '沒有可導出的訓練結果',
        exporting: '導出中...',
        pdfExportSuccess: 'PDF 報告導出成功！',
        pdfExportFailed: 'PDF 導出失敗：{message}',
        exportPdfShort: '導出 PDF',
        reportSetName: '問答集：{name}',
        reportDate: '日期：{time}',
        reportYourAnswer: '你的答案：{text}',
        reportReferenceAnswer: '參考答案：{text}',
        reportNeedsFix: '需要修正：{text}',
        reportDiff: '差異：{text}',
        reportIncorrectSummary: '錯題（含部分正確）：{count} / {total}',
        reportUnansweredSummary: '未作答：{count}',
        noCopyableReport: '沒有可複製的報告',
        copiedReport: '已複製錯誤報告到剪貼簿',
        copyReportFailed: '複製失敗，請稍後再試',
        noTrainingRecord: '沒有訓練記錄',
        confirmRestartTraining: '確定要重新開始「{name}」的訓練嗎？',
        questionDataMissing: '找不到指定的題目數據',
        answerEmptyForCheck: '該題目尚未輸入答案，無法進行校驗',
        title: '問答訓練', mySets: '我的問答集', createSet: '建立問答集', importSet: '匯入問答集', selectExisting: '選擇已有問答集', applyTemplate: '套用範本', templateHint: '選擇問答集作為起點，仍可微調後另存新集。', name: '名稱', namePlaceholder: '輸入問答集名稱', description: '描述', descriptionPlaceholder: '輸入問答集描述', pairsLabel: '問答對（每兩行一組：上一行問題、下一行答案）', pairsPlaceholder: '問題1？\n答案1。\n\n問題2？\n答案2。', loadExample: '載入示例', saveSet: '儲存問答集', cancel: '取消', progress: '第 {current} 題／共 {total} 題', checkerModel: '校對模型：', question: '問題：', questionPlaceholder: '這裏會顯示目前問題', yourAnswer: '你的答案：', answerPlaceholder: '請輸入你的答案', previous: '上一題', checkCurrent: 'AI 校對本題', next: '下一題', instantFeedback: '本題 AI 回饋', finish: '完成訓練', backSets: '返回問答集', reportTitle: 'AI 校對報告', checking: '正在進行 AI 智能校對...', checkAll: 'AI 校對全部題目', exportPdf: '匯出 PDF', copyReport: '複製錯誤報告', collapseAll: '收合全部', expandAll: '展開全部', retryTraining: '重新訓練', backMenu: '返回主選單', noSets: '尚未有問答集', startTraining: '開始訓練', edit: '編輯', export: '匯出', delete: '刪除', questionsCount: '{count} 條題目', preset: '預設', confirmDelete: '確定刪除這個問答集嗎？', importFailed: '匯入問答集失敗：{message}', exportFailed: '匯出失敗：{message}', enterName: '請輸入問答集名稱', enterPairs: '請輸入問答內容', invalidPairs: '請至少輸入一組完整的問答', saved: '問答集已儲存', updated: '問答集已更新', copied: '報告已複製到剪貼簿', copyFailed: '複製失敗，請手動複製', answerRequired: '請先輸入答案', checkingCurrent: '正在校對本題...', checkFailed: '校對失敗，請稍後再試', trainingProgress: '第 {current} 題／共 {total} 題', unanswered: '未作答', correct: '正確', incorrect: '錯誤', referenceAnswer: '參考答案', yourAnswerText: '你的答案', feedback: '回饋', score: '得分', accuracy: '正確率', totalQuestions: '題目總數', answeredQuestions: '已作答', noAnswer: '（未作答）', pdfGenerating: '正在產生 PDF...', pdfFailed: '匯出 PDF 失敗：{message}'
        ,addWord: '加入生字簿', selectWord: '請先選取要加入的字詞或片語', adding: '加入中...', exists: '已存在', added: '已加入', failed: '失敗', showDetails: '顯示詳解', hideDetails: '收合詳解', loadSetsFailed: '載入問答集失敗', configureModel: '請先到全局設定配置 provider 及模型', editSet: '編輯問答集', saveChanges: '儲存變更', customCategory: '自訂', trainingStarted: '訓練開始！', continueTraining: '已為你繼續上一個訓練。', confirmNewTraining: '已有進行中的訓練。確定開始新的訓練嗎？選擇「取消」會繼續之前的訓練。', answerSaved: '答案已儲存', allCompleted: '已完成所有題目，可以結束訓練了', aiChecking: 'AI 校對中...', aiCheckedQuestion: 'AI 已校對第 {number} 題', noResults: '尚未有作答內容。請返回填寫答案，或在列表模式下輸入後再完成訓練。', setDeleted: '問答集已刪除', importSuccess: '問答集匯入成功', setSaved: '問答集「{name}」儲存成功！', setUpdated: '問答集「{name}」已更新！', view: '查看題目', exportHandwriting: '匯出手寫默書'
        ,previewEmpty: '請輸入內容：每兩行為一組（第一行為問題，第二行為答案）', formatErrors: '格式錯誤：', parsedPairs: '成功解析 {count} 個問答對', copy: '複製', moveUp: '上移', moveDown: '下移', addPair: '新增問答', copyAll: '複製全部', clearAll: '清空全部', confirmClearPairs: '確定清空所有問答對嗎？', confirmDeleteQuestion: '刪除第 {number} 題？', pairDeleted: '已刪除該問答對', pairCopied: '已複製該題到剪貼簿', allPairsCopied: '已複製全部問答對', newQuestion: '（請輸入問題）', newAnswer: '（請輸入答案）', unansweredConfirm: '尚有 {count} 題未回答，確定完成訓練嗎？', cancelTrainingConfirm: '確定取消目前訓練嗎？所有進度都會遺失。', aiUnavailable: 'AI 服務不可用，將使用基本校對模式', noCheckableAnswers: '沒有可校對的答案（尚未輸入內容）', aiFallback: 'AI 校對失敗，改用基本校對模式'
        ,allCorrectRecommendation: '太好了！所有答案都正確，繼續保持！', spellingRecommendation: '建議多練習單詞拼寫，可以使用拼寫檢查工具', grammarRecommendation: '建議溫習相關文法規則，多做文法練習', reviewRecommendation: '有些答案需要重點留意，建議重新學習相關內容'
        ,trainingOptionsTitle: '問答訓練設定', trainingOptionsDescription: '請選擇你的訓練偏好，這些設定會影響你的學習體驗', trainingMode: '訓練模式', trainingModeDescription: '選擇問題的出現順序', sequentialMode: '順序模式', sequentialDescription: '按照原始順序練習', randomMode: '隨機模式', randomDescription: '隨機打亂問題順序', layout: '練習呈現', layoutDescription: '是否分題練習', listMode: '列表模式（預設）', listDescription: '一次列出全部題目，逐題輸入；每題可單獨 AI 校對', singleMode: '分題模式', singleDescription: '一題一題作答，逐題切換', learningAdvice: '學習建議', differenceHint: '差異提示', missing: '缺少：', extra: '多出：', partialCorrect: '部分正確', needsImprovement: '需改進', teacherFeedback: '教師回饋', aiFeedback: 'AI 回饋：', strengths: '亮點表現', aiReview: 'AI 評語自檢', aiReviewOk: 'AI 評語檢查：沒有明顯問題', improvementAdvice: '改進建議', studyFocusLabel: '學習重點', improvedExamples: '優化範例', example: '範例 {number}：', explanationLabel: '解析：', needsCorrection: '需要修正', noStandardAnswer: '尚未有標準答案', issuePunctuation: '標點／格式', issueGrammar: '文法', issueSpelling: '拼寫', issueVocabulary: '用字', issueStructure: '句子結構',
        previewTitle: '查看問答集：{name}', questionTotal: '題目數量：{count}', shuffleOrder: '隨機順序', resetOrder: '重設', copyContent: '複製內容', perPage: '每頁', lineCount: '行數', exportQuestions: '匯出手寫默書', exportAnswers: '匯出答案', startPreviewTraining: '開始訓練此問答集', close: '關閉', shuffledNotice: '已隨機打亂題目順序', resetNotice: '已重設為原順序', nothingToCopy: '沒有可複製的內容', contentCopied: '內容已複製（含序號、Q/A）', copyContentFailed: '複製內容失敗', previewFailed: '無法預覽問答集，請稍後再試。', exportQuestionsFailed: '匯出手寫默書 PDF 失敗', exportAnswersFailed: '匯出答案 PDF 失敗'
    },
    qaPdf: {
        loadSetFailed: '問答集載入失敗', loadLibraryFailed: 'jsPDF 載入失敗，請檢查網絡連線或重新整理頁面', answer: '答案：{answer}', ordered: '_順序', shuffled: '_亂序', withAnswers: '_含答案', handwriting: '_手寫版', exportSuccess: '手寫默書 PDF 已成功匯出！', exportFailed: '手寫默書 PDF 匯出失敗：{message}', handwritingTitle: '{name} - 手寫默書練習', identity: '日期：_______________    姓名：_______________    成績：_______________', instructionsWithAnswers: '說明：請根據問題寫出答案，答案已在題目下方提供參考。', instructions: '說明：請在橫線上寫出完整的英文答案，注意大小寫及標點符號。', page: '第 {current} 頁，共 {total} 頁', reportTitle: '問答訓練結果報告', errorSummary: '錯誤點彙總（精簡）', reportFile: '問答訓練報告_{name}_{date}.pdf', reportSuccess: 'PDF 報告已成功匯出！', reportFailed: 'PDF 匯出失敗：{message}', setName: '問答集名稱：{name}', trainingTime: '訓練時間：{start} - {end}', duration: '訓練時長：{duration}', mode: '訓練模式：{mode}', random: '隨機模式', sequential: '順序模式', total: '題目總數：{count}', answered: '已作答：{count}', summary: '訓練總結', incorrect: '錯題數：{count}', unanswered: '未作答：{count}', details: '詳細答案分析', questionNumber: '第 {number} 題', question: '問題：{text}', standardAnswer: '標準答案：{text}', userAnswer: '你的答案：{text}', noAnswer: '（未回答）', verdict: '判定：{result}', correct: '正確', wrong: '錯誤', feedback: '回饋：{text}', suggestion: '建議：{text}', generatedAt: '產生時間：{time}', durationShort: '{minutes}分{seconds}秒'
    },
    assistant: {
        title: 'AI 助手', model: '模型：', configureModel: '請先到全局設定配置 provider 及模型', global: '全局', article: '文章', smallWindow: '小視窗（右下角）', dockRight: '靠右全高', largeWindow: '置中大視窗', newSession: '新增會話', viewSessions: '查看會話', refreshContext: '更新上下文', close: '關閉', inputPlaceholder: '輸入與本文相關的問題，按 Enter 傳送', send: '傳送', streaming: '串流回應', fontSize: '字級：', small: '小', large: '大', contextRefreshed: '已更新文章上下文，下次提問會使用最新內容', globalSession: '全局會話', contextPrefix: '以下是目前文章內容，只作為上下文：', stop: '停止', error: '[錯誤] {message}', tryLater: '請稍後再試', retry: '重試', copy: '複製', copied: '已複製', history: '歷史會話', session: '會話', switch: '切換', rename: '重新命名', delete: '刪除', noSessions: '尚未有會話', renamePrompt: '輸入新的會話名稱：', confirmDelete: '確定刪除此會話嗎？'
        ,new: '新增', import: '匯入', modifyTitle: '修改標題', continueInAssistant: '在助手中繼續', export: '匯出', questionPlaceholder: '輸入問題…', loading: '載入中...', emptySession: '此會話尚未有訊息', loadFailed: '載入失敗', articleKeyPrompt: '請輸入文章鍵（留空為全局）', sessionName: '會話名稱', importedSession: '匯入會話', importFailed: '匯入失敗：{message}', selectSession: '請先選擇一個會話', sessionMissing: '會話不存在', noSelection: '未選擇會話', deleteFailed: '刪除失敗：{message}'
    },
    sync: {
        backupNoteManual: '手動同步後備份',
        backupNoteAuto: '自動同步後備份',
        backupNoteImport: '手動·檔案匯入',
        lastSyncWithVersion: '（上次：{time}，v{version}）',
        versionOnly: '（v{version}）',
        sessionItemTitle: '點擊預覽，雙擊直接在助手中開啟',
        globalPrefix: '全局 · ',
        loggedOut: '已登出', loggedIn: '已登入', loggedOutState: '未登入', loginFirst: '請先登入', syncing: '同步中...', autoSyncing: '自動同步中...', restoredEmpty: '已從雲端還原（偵測到本機為空）', restoredEmptyMessage: '偵測到本機為空，已自動從雲端還原', restoredAutomatic: '已從雲端還原（自動偵測）', syncDone: '同步完成', syncFailed: '同步失敗', autoSyncFailed: '自動同步失敗', unknownError: '未知錯誤', login: '登入', passcode: '通行碼', passcodePlaceholder: '輸入你的通行碼', show: '顯示', hide: '隱藏', forgot: '忘記通行碼', loginHint: '資料互相獨立，請使用分配給你的通行碼登入。', enterPasscode: '請輸入通行碼', loggingIn: '登入中...', loginSuccess: '登入成功', error: '錯誤：{message}', tryLater: '請稍後再試', loginUnavailable: '登入模組暫時不可用', changePasscode: '更改通行碼', newPasscode: '新通行碼', minSix: '至少 6 位', confirmPasscode: '確認新通行碼', enterAgain: '再輸入一次', updatePasscode: '更新通行碼', changeHint: '修改後本機會自動更新；其他裝置需要使用新通行碼重新登入。', passcodeTooShort: '新通行碼至少 6 位', mismatch: '兩次輸入不一致', updating: '更新中...', updatedPasscode: '已更新通行碼', resetPasscode: '用恢復碼重設通行碼', userId: '使用者代號', userIdPlaceholder: '例如 alice', recoveryCode: '恢復碼', recoveryPlaceholder: '建立帳戶時取得的恢復碼', backLogin: '返回登入', resetAndLogin: '重設並登入', resetHint: '忘記通行碼時，使用「使用者代號 + 恢復碼」設定新通行碼。', fillRecovery: '請填寫使用者代號及恢復碼', processing: '處理中...', resetSuccess: '重設成功，已登入', backupTitle: '本機備份與還原', restore: '還原', export: '匯出', delete: '刪除', noBackups: '尚未有備份', close: '關閉', createBackup: '建立新備份', importBackup: '匯入備份檔案', clearCache: '清理本機快取', backupCreated: '已建立備份', backupCreateFailed: '建立備份失敗：{message}', fileTooLarge: '檔案過大（>25MB），請確認是否為備份檔案', readFileFailed: '讀取檔案失敗', invalidJson: '匯入失敗：檔案不是有效的 JSON', invalidBackup: '檔案格式不符，找不到可還原的備份資料', importWriteFailed: '匯入失敗：{message}', backupImported: '已匯入備份，請在列表按「還原」套用到本機', cacheCleared: '已清理本機快取', clearFailed: '清理失敗：{message}', backupMissing: '備份不存在或已損壞', restoredLocal: '已從備份還原（只限本機）', restoreFailed: '還原失敗：{message}', backupExported: '已匯出備份', exportFailed: '匯出失敗', backupDeleted: '已刪除備份', deleteFailed: '刪除失敗', settings: '設定', approximately: '約 {size} KB'
    },
    ai: {
        analysisFailed: '分析失敗'
    }
};
