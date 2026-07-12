export default {
    app: {
        documentTitle: '背单词应用',
        title: 'PEN子背单词',
        settings: '设置'
    },
    nav: {
        vocabulary: { full: '单词本', short: '词' },
        dictation: { full: '听写模式', short: '听' },
        learning: { full: '学习模式', short: '学' },
        qa: { full: '问答训练', short: '问' },
        article: { full: '文章详解', short: '文' },
        ocr: { full: '图片识别', short: '图' },
        quiz: { full: '随堂测验', short: '测' }
    },
    settings: {
        globalTitle: '全局设置',
        languageLabel: '显示语言',
        languageHint: '界面和 AI 回复使用所选语言，学习内容保持原样。',
        savedLocal: '已保存（仅本机）',
        saveFailed: '保存失败：', ttsSource: 'TTS 来源', remote: '远程', local: '本地', custom: '自定义', ttsSourceHint: '一般用户只需选择来源；需要自定义时再输入 URL', customTtsUrl: '自定义 TTS 基础 URL', ttsKey: 'TTS API Key（仅保存在本机）', englishVoicePreference: '英语朗读首选', britishEnglish: '英音 en-GB', americanEnglish: '美音 en-US', defaultBritish: '未指定时默认英音', chineseVoicePreference: '中文朗读首选', mandarin: '普通话 zh-CN', cantonese: '粤语 zh-HK', ttsVoices: 'TTS 声音（仅显示：美音、英音、粤语、普通话）', reloadList: '重新加载列表', englishAmerican: '英语（美音 en-US）', englishBritish: '英语（英音 en-GB）', cantoneseVoice: '粤语（广东话 zh-HK）', mandarinVoice: '中文（普通话 zh-CN）', previewVoice: '试听', loading: '正在加载...', voiceLoadHint: '如果加载失败，请确认 TTS 基础 URL 或 ai-config.js 的 voicesUrl 可以访问。', assistant: 'AI 助手', enableAssistant: '启用助手', streaming: '流式响应', assistantHint: '右下角入口 · 流式响应更顺畅', cancel: '取消', save: '保存', localOnlyHint: '设置仅保存在本机，不会同步到云端。'
        ,localeCn: '大陆简体中文', localeHk: '香港繁体中文', providerSettings: 'AI Provider 设置', addProvider: '新增 provider', enabled: '启用', fetched: '已获取', fetching: '获取中', fetchFailed: '获取失败', notFetched: '尚未获取', fetchModels: '获取模型', remove: '移除', name: '名称', displayName: '显示名称', apiUrlOptional: 'API URL（可选）', modelsUrlOptional: 'Models URL（可选）', deriveApiUrl: '留空则由 Base URL 推导', deriveModelsUrl: '留空则默认为 baseUrl + /v1/models', apiKeyLocal: 'API Key（仅本机）', allowedModels: '允许模型', selectedModels: '已选 {selected} / 全部 {total}', modelHint: '勾选后会出现在各任务下拉列表', noModels: '还没有模型，可以先获取或手动新增。', manualModel: '手动新增模型，例如 gpt-4.1-mini 或 provider:model', addModel: '新增模型', manualAdded: '手动新增', providerHint: '可设置 baseUrl / key，获取模型后勾选允许列表；default 仍作为全局回退。', taskMapping: 'AI Task → 模型映射', taskHint: '各任务仅显示允许模型；如果当前值不在允许列表中，会暂时保留显示。', providerIdPrompt: '请输入 provider ID（英文、数字、- 或 _）', providerExists: '此 provider ID 已存在', taskWord: '查词 / 单词分析', taskSentence: '造句检查', taskQa: '问答 AI 校对', taskArticle: '文章详解', taskCleanup: '文章 AI 清洗', taskExamples: '例句生成', taskOcr: 'OCR / 视觉', taskAssistant: 'AI 助手'
        ,noAvailable: '没有可用选项', voicesLoaded: '已加载，共 {count} 个声音', loadFailed: '加载失败', loadFailedMessage: '加载失败：{message}', noVoice: '没有可用的声音可试听', playbackFailed: '播放失败，已在 Console 输出测试 URL，请检查响应格式与 voice 代码。', fallbackVoice: '提示：该声音可能不受后端支持，已使用默认备用声音试听。', assistantEntryTitle: '右下角浮窗入口', streamTitle: '流式响应可减少等待'
    },
    common: {
        increase: '增加',
        decrease: '减少',
        noBooks: '没有可用的单词本。',
        optionsTitle: '选项设置',
        cancel: '取消',
        confirm: '确定'
    },
    vocabulary: {
        myBooks: '我的单词本',
        addBook: '新增单词本',
        importBook: '导入单词本',
        selectBook: '请选择一个单词本',
        completeMissing: '补全缺失资料',
        mergeBooks: '合并单词本',
        exportBook: '导出单词本',
        editWords: '编辑单词',
        deleteBook: '删除单词本',
        chooseOrCreate: '请从左侧选择或创建一个单词本',
        noBooksImport: '还没有单词本。{link}，或点击上方“导入单词本”。',
        importHere: '点击这里导入',
        emptyBook: '这个单词本是空的，点击右上角铅笔按钮添加单词。'
        ,newBookTitle: '新增单词本'
        ,editBookTitle: '编辑单词本 - {name}'
        ,bookName: '单词本名称'
        ,bookNamePlaceholder: '例如：雅思核心词汇'
        ,bulkWords: '批量新增单词（每行一个）'
        ,bulkWordsPlaceholder: '可以只输入英文单词，例如：\napple\nbanana\ncherry\n系统将自动补全音标和释义。'
        ,create: '创建'
        ,sourceUrl: '来源网址（可选）'
        ,sourceUrlHint: '填写网址后，“打开原文”会使用此链接；留空则不显示。'
        ,wordFormat: '单词内容（格式：单词#中文@音标）'
        ,wordFormatHint: '只有英文单词的行会尝试自动补全音标和释义。'
        ,saveChanges: '保存更改'
        ,deleteConfirm: '确定要永久删除单词本“{name}”吗？此操作无法撤销。'
        ,exportNoActive: '没有当前单词本可以导出。'
        ,exported: '单词本“{name}”已导出。'
        ,mergeNeedTwo: '至少需要两个单词本才能合并。'
        ,mergeTitle: '合并单词本'
        ,newMergedName: '新单词本名称'
        ,mergedNamePlaceholder: '例如：我的合集'
        ,dedupeHint: '重复单词会被自动移除。'
        ,keepSourcesHint: '不勾选则保留原单词本。'
        ,merge: '合并'
        ,duplicateName: '已经存在名为“{name}”的单词本，请使用其他名称。'
        ,mergeSuccess: '成功将 {count} 个单词本合并为“{name}”{suffix}！'
        ,sourcesDeleted: '（已删除来源单词本）'
        ,nameRequired: '单词本名称不能为空！'
        ,processing: '处理中...'
        ,completeMissingTitle: '补全缺失资料'
        ,completeMissingHint: '短语会优先使用保存的上下文补全中文释义，并补上整体或逐词 IPA。'
        ,dedupe: '合并去重'
        ,startAction: '开始'
        ,stopAction: '停止'
        ,completing: '正在补全：{word}（{done}/{total}）'
        ,completeResult: '完成：更新 {updated} 条，跳过 {skipped} 条。'
        ,dedupeResult: '去重完成：移除 {removed} 条重复记录。'
        ,dedupeFailed: '去重失败，请稍后再试。'
        ,beforeStart: '开始之前'
        ,cloudAccountHint: '已有云端账号？可以直接登录并同步已有单词本。'
        ,later: '稍后'
        ,login: '登录'
        ,importTitle: '导入单词本'
        ,loadingPresets: '正在加载预设单词本...'
        ,noPresets: '没有找到可用的预设单词本。'
        ,presetSection: '从预设列表选择'
        ,urlSection: '从 URL 导入'
        ,urlLabel: '单词本 URL'
        ,fileSection: '从文件导入'
        ,fileLabel: '选择 JSON 文件'
        ,loginSyncHint: '已有账号？登录后可以同步云端单词本，无需再次导入。'
        ,importSelected: '导入选中项'
        ,loadFailed: '加载失败，请稍后再试。'
        ,processingSource: '正在处理：{name}...'
        ,loadingSourceFailed: '无法加载：{name}'
        ,invalidFile: '文件格式无效'
        ,readFileFailed: '读取文件失败'
        ,unknownSource: '未知的来源类型'
        ,invalidSourceData: '数据源 {name} 格式不正确。'
        ,skipped: '已跳过：{name}'
        ,parsing: '正在解析：{line}（{current}/{total}）'
        ,overwritten: '已覆盖：{name}'
        ,imported: '已导入：{name}'
        ,importFailed: '导入失败：{name}'
        ,overwriteConfirm: '单词本“{name}”已存在，要覆盖吗？'
        ,invalidUrl: '“{url}”不是有效的 URL。'
        ,selectSource: '请至少选择一个预设单词本、提供 URL 或选择文件。'
        ,importing: '正在导入...'
        ,importComplete: '导入完成！\n\n{summary}'
        ,importNoChanges: '导入完成，但没有任何更改。'
        ,importProcessFailed: '导入过程中发生错误，请查看控制台日志。'
        ,currentBookLabel: '当前单词本：', missingSummary: '共 {total} 条，其中缺失资料（音标为 n/a 或空白，或中文释义缺失）的有 {missing} 条。', defaultBookName: '单词本', nothingToAdd: '没有可加入的文字。', existsInBook: '“{word}”已存在于《{book}》。', addedToBook: '已加入“{word}”到《{book}》。'
    },
    dictation: {
        title: '听写模式',
        settings: '设置',
        selectBook: '选择单词本：',
        repeat: '重复：',
        repeatSlider: '滑动设置重复次数',
        interval: '单词间隔：',
        intervalSlider: '滑动设置单词间隔',
        chinese: '中文：',
        mandarinShort: '普',
        cantoneseShort: '粤',
        loop: '循环模式：',
        shuffle: '随机播放：',
        listenOnly: '只听不练：',
        start: '开始听写',
        stop: '停止',
        pause: '暂停',
        resume: '继续',
        replay: '重播',
        previous: '⬅️ 上一个',
        next: '下一个 ➡️',
        aiGrade: 'AI 批改手写',
        practice: '听写练习',
        inputPlaceholder: '请输入听到的单词',
        check: '检查',
        selectBookAlert: '请先选择一个包含单词的单词本！',
        stopped: '已停止',
        completed: '听写完成',
        startFirst: '请先开始听写！',
        correct: '正确！',
        incorrect: '错误！正确答案是：{answer}',
        noPhonetic: '暂无音标',
        wordList: '单词列表',
        showWordInfo: '显示单词信息',
        expandWordList: '展开单词列表',
        collapseWordList: '收起单词列表',
        previousTitle: '上一个单词',
        nextTitle: '下一个单词',
        replayTitle: '重播当前单词',
        restoreSession: '检测到未完成的听写会话：\n开始时间：{startTime}\n进度：{current}/{total}\n\n是否继续之前的会话？'
    },
    dictationGrader: {
        title: 'AI 批改手写（OCR）',
        historyTitle: '批改历史',
        resultTitle: '批改结果',
        emptyHistory: '暂无历史记录。',
        meta: '模型：{model} · 图片：{images} · 词表：{words}',
        view: '查看',
        delete: '删除',
        clearAll: '清空全部',
        confirmClear: '确定清空全部历史？此操作不可撤销。',
        confirmDelete: '确定删除此记录？',
        takePhoto: '拍照',
        gallery: '从相册选择',
        includeMeaning: '对照中文意思（若有）',
        strictCase: '严格区分大小写',
        localMode: 'OCR + 本地比对',
        aiMode: '直接交给 AI 批改',
        promptPlaceholder: '自定义 AI 批改提示词',
        run: '识别并批改',
        save: '保存结果',
        history: '查看历史',
        copy: '复制 Markdown',
        downloadCsv: '下载 CSV',
        initialStatus: '请上传或拍照后点击“识别并批改”',
        selectedImages: '已选择 {count} 张图片',
        noImages: '尚未选择图片',
        uploadFirst: '请先上传或拍照',
        processing: '正在识别与批改...',
        completed: '批改完成（AI）',
        failed: '处理失败：{message}',
        noResult: '没有可保存的结果',
        saved: '已保存：{time}',
        copied: '已复制 Markdown 到剪贴板',
        copyFailed: '复制失败，请手动选取',
        currentWords: '当前对照单词 {count} 个',
        standardAnswer: '标准答案', writing: '书写内容', chineseReference: '中文（参考）', result: '结果',
        correct: '正确', wrongSuggestion: '错误 → 建议：{suggestion}', viewRecord: '查看记录：{time}'
    },
    menu: {
        syncNow: '立即同步',
        login: '登录',
        changePasscode: '更改通行码',
        logout: '退出登录',
        globalSettings: '全局设置',
        gradingHistory: '听写批改历史',
        assistantSessions: 'AI 会话',
        backupRestore: '备份与恢复'
    },
    ocr: {
        title: '图片文字识别（OCR）', upload: '上传图片：', preferCamera: '优先使用相机', openCamera: '打开相机', clear: '清除', clearTitle: '清除已添加的图片和结果', stop: '停止', run: '识别文字', notStarted: '尚未开始', advanced: '高级选项', prompt: '补充要求：', promptPlaceholder: '例如：只提取右下角蓝色对话框文字', presets: '常用模板：', presetDefault: '常用模板...', model: 'OCR 模型：', merge: '多张图片合并为一段输出', capture: '拍照', closeCamera: '关闭相机', dropAria: '拖放或粘贴图片以加入 OCR', pasteHint: '提示：在此区域按 Ctrl+V 或 ⌘+V 可以直接粘贴截图，也可以拖放图片。', result: '识别结果', added: '已添加 {count} 张图片', addFailed: '添加图片失败：{message}', readFailed: '读取图片失败：{message}', duplicateSkipped: '已跳过重复图片', skippedDuplicates: '已跳过 {count} 张重复图片', captureFailed: '拍照失败：{message}', uploadFirst: '请先上传图片或拍照', taskRunning: '任务进行中，请先停止或等待完成', recognizing: '正在识别 {done}/{total} 张图片...', pending: '待处理', processing: '处理中', done: '完成', cancelled: '已取消', failed: '失败', completedSummary: '识别完成：{total} 张（成功 {success}，失败 {failed}，取消 {cancelled}）', completed: '完成！', recognizeFailed: '识别失败：{message}', stopped: '已停止，未完成的将标记为取消', retry: '点击重试', retryDone: '重试完成', retryFailed: '重试失败：{message}', pasteFailed: '粘贴图片失败：{message}', cameraUnsupported: '此浏览器不支持直接打开相机，将改用“拍照上传”。', insecureCamera: '当前不是安全来源（需要 HTTPS 或 localhost），浏览器阻止了相机访问。将改用“拍照上传”。', insecureCameraShort: '当前不是安全来源，浏览器可能阻止相机。建议使用 HTTPS 或 localhost。', cameraAccessFailed: '无法访问相机：{message}'
        ,presetHint: '选择模板会附加到提示词', displayMode: '显示模式', plainText: '纯文本', markdownPreview: 'Markdown 预览', resultPlaceholder: '识别后的文字将显示在此处', configureModel: '请先到全局设置配置 provider 与模型', presetBluePrompt: '只提取图片中右下角蓝色对话框的所有文字，按原有换行输出；忽略其他区域与 UI 元素。', presetBlueLabel: '只提取：右下角蓝色对话框', presetEnglishPrompt: '仅输出图片中的英文与阿拉伯数字，保留原始换行；忽略图标、按钮、界面元素与背景噪声。', presetEnglishLabel: '只提取：英文与数字', presetBodyPrompt: '请将正文完整转写为纯文本，保留原始换行与标点；删除页码、分隔线、图标与界面文字。', presetBodyLabel: '正文转写，移除 UI／噪声', presetQuizPrompt: '如果是题目图片，仅提取题干与选项文字，依次以 A)、B)、C)、D) 标示；不要输出解析或多余内容。', presetQuizLabel: '试题模式：题干＋选项', presetMarkdownPrompt: '输出为 Markdown 列表：每个段落作为一个条目，如果有小标题请使用二级标题。', presetMarkdownLabel: '输出格式：Markdown 列表', presetDictationPrompt: '这是一张听写单词的照片。请逐行提取学生书写的英文单词或短语，保留顺序与原始大小写。接着检查每行拼写是否正确，如果有中文意思，也检查中文书写是否正确：正确请在行末标注（正确）；错误请标注（错→建议：correct）。只输出纯文本列表，不要翻译或加入多余解释。', presetDictationLabel: '小学生听写单词：检查拼写'
        ,imageHeader: '--- 图片 {current}/{total}：{name} ---'
    },
    quiz: {
        leaveConfirmation: '测验正在进行中，确定要离开吗？',
        title: '随堂测验',
        settings: '测验设置',
        selectBook: '选择单词本：',
        count: '题目数量：',
        countSlider: '滑动设置题目数量',
        type: '测验类型：',
        typeMeaning: '看英文选中文',
        typeWord: '看中文选英文',
        typePhonetic: '看音标选单词',
        typeMixed: '混合模式',
        start: '开始测验',
        stop: '结束测验',
        next: '下一题',
        completed: '测验完成！',
        restart: '重新测验',
        needFourWords: '请先选择一个至少包含 4 个单词的单词本开始测验！',
        stopped: '测验已停止！',
        noMeaning: '（无中文意思）',
        askMeaning: '“{word}”的中文意思是？',
        askWord: '“{meaning}”对应的英文单词是？',
        askPhonetic: '音标“{phonetic}”对应的单词是？',
        progress: '题目 {current}/{total}',
        score: '得分：{score}/{total}',
        excellent: '优秀！您对这些单词掌握得很好！',
        good: '良好！继续保持，再接再厉！',
        pass: '及格！建议多复习这些单词。',
        improve: '需要加强！请多花时间学习这些单词。'
    },
    learning: {
        selectWord: '请先选择一个单词！',
        enterSentence: '请输入一个例句！',
        mustContainWord: '您的例句必须包含单词“{word}”。',
        checking: '正在检查...',
        sentenceCorrect: '很好！您的例句正确。',
        sentenceHasIssues: '您的例句有一些问题。',
        suggestion: '建议：',
        requestFailed: '检查例句失败，请检查 API Key 或网络连接后再试。',
        checkFailed: '检查失败。',
        title: '学习模式',
        selectBook: '选择单词本：',
        selectWordTitle: '选择单词',
        selectBookFirst: '请先从上方选择单词本',
        currentBookEmpty: '当前单词本为空',
        selectWordOption: '请选择单词',
        noMeaning: '（无中文意思）',
        speakWord: '朗读单词',
        examples: '例句',
        generateExamples: '生成 AI 例句',
        generating: '生成中...',
        generateFailed: '生成例句失败，请检查 API Key 或网络连接后再试。',
        noExamples: '还没有例句，点击“生成 AI 例句”按钮生成例句。',
        sentencePractice: '造句练习',
        sentencePlaceholder: '请使用此单词造句',
        check: '检查'
    },
    article: {
        title: '文章详解', inputTitle: '输入文章', historyRead: '读取历史记录', historyManage: '管理记录', historyManageTitle: '管理阅读记录', historyDelete: '删除记录', historyDeleteTitle: '删除选中的历史记录', inputPlaceholder: '在这里输入或粘贴您想分析的文章...', analyze: '分析文章', import: '导入...', importTitle: '从网址或图片导入文章', retryFailed: '重试失败段', clear: '清除重写', library: '从文章库选取', compactHint: '当前文章详解采用精简模式：仅输出中文翻译。', readingControls: '朗读控制', read: '朗读文章', stopReading: '停止朗读', downloadAudio: '下载语音', mode: '模式：', full: '全文', paragraph: '段落', sentence: '句子', dimming: '淡化强度：', dimmingTitle: '调整非当前句子的淡化程度', repeat: '重复：', repeatTitle: '设置段落/句子朗读的重复次数', repeatSlider: '滑动设置重复次数', speed: '语速：', previousSentence: '上一句', nextSentence: '下一句', previousParagraph: '上一段', nextParagraph: '下一段', result: '分析结果', maskAria: '翻译遮罩', maskLabel: '迷雾', maskTitle: '翻译遮罩：默认开启；鼠标移入/按住显示', sourceEmpty: '来源：—', sourcePrefix: '来源：', sourceUrl: '网页 / 新闻', sourceFile: '文章库 / 文件', sourceOcr: '图片 OCR', sourcePaste: '粘贴文字', openSource: '打开原文', initialHint: '请先输入文章并点击分析按钮。', untitled: '未命名文章', importModal: '导入文章', importUrl: '网址导入', importNews: '新闻来源', importOcr: '图片 OCR', importQa: '问答集', pasteUrl: '粘贴网址', fetch: '提取', chooseFile: '选择文件', chooseFileTitle: '从本机文件导入 .md/.txt', cleanupOptions: '清洗选项', aiCleanup: 'AI 清洗内容（更适合阅读）', keepImages: '保留图片', autoApply: '提取后自动应用', skipThirdParty: '跳过第三方转换', cleanupModel: '清洗模型', configureModel: '请先到全局设置配置 provider 与模型', dropTextFile: '拖放 .md / .txt 到此，或聚焦后按 Ctrl+V 粘贴全文', beforeCleanup: '清洗前', afterCleanup: '清洗后', applyInput: '应用到输入框', chooseImages: '选择图片', preferCamera: '优先使用相机', addImages: '新增图片', clearImages: '清空', ocrModel: 'OCR 模型', dropImages: '拖放图片到此，或在此窗口粘贴截图', prompt: '提示词', promptPlaceholder: '例如：仅输出图片中的文章正文，保留原始换行；忽略 UI 元素与噪声', extractImageText: '提取图片文字', mergeOutput: '合并输出', ocrPreview: 'OCR 结果预览', ocrHint: '使用 AI 视觉模型提取图片中的文本，保留原始换行与标点。', remove: '移除', selectImagesFirst: '请先选择图片', extracting: '提取中...', imageNumber: '图片 {number}', ocrFailed: 'OCR 失败：{message}', selectQa: '选择问答集', importAsArticle: '导入为文章', preview: '预览', preset: '（预置）', selectQaFirst: '请先选择问答集', loadQaFailed: '加载问答集失败', qaDefault: '问答集', importHint: '将通过 r.jina.ai 尝试提取阅读版内容；如果失败则改用简单提取。', enterArticle: '请输入要分析的文章！', analyzing: '分析中...', preparing: '准备中...', analyzingParagraph: '正在分析第 {number} 段...', completedParagraphs: '已完成 {count} 段分析', retryParagraph: '重试本段', elapsed: '耗时', cancelled: '已取消此次分析。', analysisFailed: '分析失败！请检查 API Key 或网络连接后再试。', invalidArticle: '请输入有效的文章内容！', invalidResponse: 'API 返回的数据格式不完整。', noHistory: '尚无阅读记录。', unknownTime: '未记录时间', analyzed: '已分析', notAnalyzed: '未分析', load: '加载', delete: '删除', clearAll: '清空全部', historyManager: '阅读记录管理', confirmClearHistory: '确定清空全部阅读记录？此操作不可撤回。', confirmDeleteHistory: '确定删除此阅读记录？', selectHistory: '请先选择一个历史记录！', noContent: '无内容', noLibraryMatch: '没有符合条件的文章。', loadingLibrary: '正在加载文章列表...', emptyLibrary: '文章库为空。', loadLibraryFailed: '加载文章列表失败。', allCategories: '全部分类', uncategorized: '未分类', articleCount: '{count} 篇', loadArticleFailed: '加载文章失败！'
        ,doneStatus: '完成 ✓', refresh: '重新获取', refreshing: '重新获取中...', sentenceAnalysis: '句子解析', collapse: '收起', close: '关闭', closeWindow: '关闭窗口', details: '详解', detailsLoading: '详解加载中...', loading: '加载中...', loadingDetails: '正在加载详解...', analyzeSelection: '分析选中内容', selectPhraseHint: '选中句中短语后点击', collapseArea: '点击此区域收起', collapseAreaAria: '点击右侧空白区域可收起', selectPhraseFirst: '请先在该句中选中短语', analyzingSelection: '分析中...', phraseLabel: '短语：', usageLabel: '用法：', roleLabel: '作用：', meaningLabel: '意思：', pronunciation: '发音', analyzePhrase: '分析短语', analyzeOtherPhrase: '自定义短语...', phrasePrompt: '输入要分析的短语', analysisRetry: '分析失败，请稍后再试', analysisRetryShort: '分析失败，请稍后重试', noAnalysisData: '未找到分析数据。', retry: '重试', retrying: '重试中...', addToWordbook: '加入单词本', addSelectedToWordbook: '加入单词本（选中）', selectWordOrPhrase: '请先在该句中选中词语或短语', wordAnalysisFailed: '分析失败。'
    },
    qa: {
        title: '问答训练', mySets: '我的问答集', createSet: '创建问答集', importSet: '导入问答集', selectExisting: '选择已有问答集', applyTemplate: '应用模板', templateHint: '选择问答集作为起点，仍可微调后另存新集。', name: '名称', namePlaceholder: '输入问答集名称', description: '描述', descriptionPlaceholder: '输入问答集描述', pairsLabel: '问答对（每两行一组：上一行问题、下一行答案）', pairsPlaceholder: '问题1？\n答案1。\n\n问题2？\n答案2。', loadExample: '加载示例', saveSet: '保存问答集', cancel: '取消', progress: '第 {current} 题 / 共 {total} 题', checkerModel: '校对模型：', question: '问题：', questionPlaceholder: '这里将显示当前问题', yourAnswer: '您的答案：', answerPlaceholder: '请输入您的答案', previous: '上一题', checkCurrent: 'AI 校对本题', next: '下一题', instantFeedback: '本题 AI 反馈', finish: '完成训练', backSets: '返回问答集', reportTitle: 'AI 校对报告', checking: '正在进行 AI 智能校对...', checkAll: 'AI 校对全部题目', exportPdf: '导出 PDF', copyReport: '复制错误报告', collapseAll: '收起全部', expandAll: '展开全部', retryTraining: '重新训练', backMenu: '返回主菜单', noSets: '还没有问答集', startTraining: '开始训练', edit: '编辑', export: '导出', delete: '删除', questionsCount: '{count} 道题', preset: '预置', confirmDelete: '确定删除这个问答集吗？', importFailed: '导入问答集失败：{message}', exportFailed: '导出失败：{message}', enterName: '请输入问答集名称', enterPairs: '请输入问答内容', invalidPairs: '请至少输入一组完整的问答', saved: '问答集已保存', updated: '问答集已更新', copied: '报告已复制到剪贴板', copyFailed: '复制失败，请手动复制', answerRequired: '请先输入答案', checkingCurrent: '正在校对本题...', checkFailed: '校对失败，请稍后再试', trainingProgress: '第 {current} 题 / 共 {total} 题', unanswered: '未作答', correct: '正确', incorrect: '错误', referenceAnswer: '参考答案', yourAnswerText: '您的答案', feedback: '反馈', score: '得分', accuracy: '正确率', totalQuestions: '总题数', answeredQuestions: '已作答', noAnswer: '（未作答）', pdfGenerating: '正在生成 PDF...', pdfFailed: '导出 PDF 失败：{message}'
        ,addWord: '加入单词本', selectWord: '请先选取要加入的词语或短语', adding: '加入中...', exists: '已存在', added: '已加入', failed: '失败', showDetails: '显示详解', hideDetails: '收起详解', loadSetsFailed: '加载问答集失败', configureModel: '请先到全局设置配置 provider 与模型', editSet: '编辑问答集', saveChanges: '保存更改', customCategory: '自定义', trainingStarted: '训练开始！', continueTraining: '已为您继续上一个训练。', confirmNewTraining: '已有进行中的训练。确定开始新的训练吗？选择“取消”将继续之前的训练。', answerSaved: '答案已保存', allCompleted: '已完成所有题目，可以结束训练了', aiChecking: 'AI 校对中...', aiCheckedQuestion: 'AI 已校对第 {number} 题', noResults: '还没有作答内容。请返回填写答案，或在列表模式下输入后再完成训练。', setDeleted: '问答集已删除', importSuccess: '问答集导入成功', setSaved: '问答集“{name}”保存成功！', setUpdated: '问答集“{name}”已更新！', view: '查看题目', exportHandwriting: '导出手写练习'
        ,previewEmpty: '请输入内容：每两行为一组（第一行为问题，第二行为答案）', formatErrors: '格式错误：', parsedPairs: '✅ 成功解析 {count} 个问答对', copy: '复制', moveUp: '上移', moveDown: '下移', addPair: '新增问答', copyAll: '复制全部', clearAll: '清空全部', confirmClearPairs: '确定清空所有问答对吗？', confirmDeleteQuestion: '删除第 {number} 题？', pairDeleted: '已删除该问答对', pairCopied: '已复制该题到剪贴板', allPairsCopied: '已复制全部问答对', newQuestion: '（请输入问题）', newAnswer: '（请输入答案）', unansweredConfirm: '还有 {count} 题未回答，确定完成训练吗？', cancelTrainingConfirm: '确定取消当前训练吗？所有进度都将丢失。', aiUnavailable: 'AI 服务不可用，将使用基本校对模式', noCheckableAnswers: '没有可校对的答案（尚未输入内容）', aiFallback: 'AI 校对失败，改用基本校对模式'
        ,allCorrectRecommendation: '太棒了！所有答案都正确，继续保持！', spellingRecommendation: '建议多练习单词拼写，可以使用拼写检查工具', grammarRecommendation: '建议复习相关语法规则，多做语法练习', reviewRecommendation: '有些答案需要重点关注，建议重新学习相关内容'
        ,trainingOptionsTitle: '🎯 问答训练设置', trainingOptionsDescription: '请选择您的训练偏好，这些设置将影响您的学习体验', trainingMode: '训练模式', trainingModeDescription: '选择问题的出现顺序', sequentialMode: '顺序模式', sequentialDescription: '按照原始顺序练习', randomMode: '随机模式', randomDescription: '随机打乱问题顺序', layout: '练习呈现', layoutDescription: '是否分题练习', listMode: '列表模式（默认）', listDescription: '一次列出全部题目，逐题输入；每题可单独 AI 校对', singleMode: '分题模式', singleDescription: '一题一题作答，逐题切换', learningAdvice: '📝 学习建议', differenceHint: '差异提示', missing: '缺少：', extra: '多出：', partialCorrect: '部分正确', needsImprovement: '需改进', teacherFeedback: '教师反馈', aiFeedback: 'AI 反馈：', strengths: '亮点表现', aiReview: 'AI 评语自检', aiReviewOk: 'AI 评语检查：无明显问题', improvementAdvice: '改进建议', studyFocusLabel: '学习重点', improvedExamples: '优化示例', example: '示例 {number}：', explanationLabel: '解析：', needsCorrection: '需要修正', noStandardAnswer: '还没有标准答案', issuePunctuation: '标点／格式', issueGrammar: '语法', issueSpelling: '拼写', issueVocabulary: '用词', issueStructure: '句子结构',
        previewTitle: '查看问答集：{name}', questionTotal: '题目数量：{count}', shuffleOrder: '随机顺序', resetOrder: '重置', copyContent: '复制内容', perPage: '每页', lineCount: '行数', exportQuestions: '导出手写练习', exportAnswers: '导出答案', startPreviewTraining: '开始训练此问答集', close: '关闭', shuffledNotice: '已随机打乱题目顺序', resetNotice: '已重置为原顺序', nothingToCopy: '没有可复制的内容', contentCopied: '内容已复制（含序号、Q/A）', copyContentFailed: '复制内容失败', previewFailed: '无法预览问答集，请稍后再试。', exportQuestionsFailed: '导出手写练习 PDF 失败', exportAnswersFailed: '导出答案 PDF 失败'
    },
    qaPdf: {
        loadSetFailed: '问答集加载失败', loadLibraryFailed: 'jsPDF 加载失败，请检查网络连接或刷新页面', answer: '答案：{answer}', ordered: '_顺序', shuffled: '_乱序', withAnswers: '_含答案', handwriting: '_手写版', exportSuccess: '手写练习 PDF 已成功导出！', exportFailed: '手写练习 PDF 导出失败：{message}', handwritingTitle: '{name} - 手写练习', identity: '日期：_______________    姓名：_______________    成绩：_______________', instructionsWithAnswers: '说明：请根据问题写出答案，答案已在题目下方提供参考。', instructions: '说明：请在横线上写出完整的英文答案，注意大小写和标点符号。', page: '第 {current} 页，共 {total} 页', reportTitle: '问答训练结果报告', errorSummary: '错误点汇总（精简）', reportFile: '问答训练报告_{name}_{date}.pdf', reportSuccess: 'PDF 报告已成功导出！', reportFailed: 'PDF 导出失败：{message}', setName: '问答集名称：{name}', trainingTime: '训练时间：{start} - {end}', duration: '训练时长：{duration}', mode: '训练模式：{mode}', random: '随机模式', sequential: '顺序模式', total: '题目总数：{count}', answered: '已作答：{count}', summary: '训练总结', incorrect: '错题数：{count}', unanswered: '未作答：{count}', details: '详细答案分析', questionNumber: '第 {number} 题', question: '问题：{text}', standardAnswer: '标准答案：{text}', userAnswer: '您的答案：{text}', noAnswer: '（未回答）', verdict: '判定：{result}', correct: '正确', wrong: '错误', feedback: '反馈：{text}', suggestion: '建议：{text}', generatedAt: '生成时间：{time}', durationShort: '{minutes}分{seconds}秒'
    },
    assistant: {
        title: 'AI 助手', model: '模型：', configureModel: '请先到全局设置配置 provider 与模型', global: '全局', article: '文章', smallWindow: '小窗口（右下角）', dockRight: '靠右全高', largeWindow: '居中大窗口', newSession: '新建会话', viewSessions: '查看会话', refreshContext: '刷新上下文', close: '关闭', inputPlaceholder: '输入与本文相关的问题，按 Enter 发送', send: '发送', streaming: '流式响应', fontSize: '字号：', small: '小', large: '大', contextRefreshed: '已刷新文章上下文，下次提问将使用最新内容', globalSession: '全局会话', contextPrefix: '以下是当前文章内容，仅作为上下文：', stop: '停止', error: '[错误] {message}', tryLater: '请稍后再试', retry: '重试', copy: '复制', copied: '已复制', history: '历史会话', session: '会话', switch: '切换', rename: '重命名', delete: '删除', noSessions: '还没有会话', renamePrompt: '输入新的会话名称：', confirmDelete: '确定删除此会话吗？'
        ,new: '新建', import: '导入', modifyTitle: '修改标题', continueInAssistant: '在助手中继续', export: '导出', questionPlaceholder: '输入问题…', loading: '加载中...', emptySession: '此会话还没有消息', loadFailed: '加载失败', articleKeyPrompt: '请输入文章键（留空为全局）', sessionName: '会话名称', importedSession: '导入会话', importFailed: '导入失败：{message}', selectSession: '请先选择一个会话', sessionMissing: '会话不存在', noSelection: '未选择会话', deleteFailed: '删除失败：{message}'
    },
    sync: {
        loggedOut: '已退出登录', loggedIn: '已登录', loggedOutState: '未登录', loginFirst: '请先登录', syncing: '同步中...', autoSyncing: '自动同步中...', restoredEmpty: '已从云端恢复（检测到本机为空）', restoredEmptyMessage: '检测到本机为空，已自动从云端恢复', restoredAutomatic: '已从云端恢复（自动检测）', syncDone: '同步完成', syncFailed: '同步失败', autoSyncFailed: '自动同步失败', unknownError: '未知错误', login: '登录', passcode: '通行码', passcodePlaceholder: '输入您的通行码', show: '显示', hide: '隐藏', forgot: '忘记通行码', loginHint: '数据相互独立，请使用分配给您的通行码登录。', enterPasscode: '请输入通行码', loggingIn: '登录中...', loginSuccess: '登录成功', error: '错误：{message}', tryLater: '请稍后再试', loginUnavailable: '登录模块暂时不可用', changePasscode: '更改通行码', newPasscode: '新通行码', minSix: '至少 6 位', confirmPasscode: '确认新通行码', enterAgain: '再输入一次', updatePasscode: '更新通行码', changeHint: '修改后本机将自动更新；其他设备需要使用新通行码重新登录。', passcodeTooShort: '新通行码至少 6 位', mismatch: '两次输入不一致', updating: '更新中...', updatedPasscode: '已更新通行码', resetPasscode: '用恢复码重置通行码', userId: '用户代号', userIdPlaceholder: '例如 alice', recoveryCode: '恢复码', recoveryPlaceholder: '创建账号时获得的恢复码', backLogin: '返回登录', resetAndLogin: '重置并登录', resetHint: '忘记通行码时，使用“用户代号 + 恢复码”设置新通行码。', fillRecovery: '请填写用户代号与恢复码', processing: '处理中...', resetSuccess: '重置成功，已登录', backupTitle: '本机备份与恢复', restore: '恢复', export: '导出', delete: '删除', noBackups: '还没有备份', close: '关闭', createBackup: '创建新备份', importBackup: '导入备份文件', clearCache: '清理本机缓存', backupCreated: '已创建备份', backupCreateFailed: '创建备份失败：{message}', fileTooLarge: '文件过大（>25MB），请确认是否为备份文件', readFileFailed: '读取文件失败', invalidJson: '导入失败：文件不是有效的 JSON', invalidBackup: '文件格式不符，找不到可恢复的备份数据', importWriteFailed: '导入失败：{message}', backupImported: '已导入备份，请在列表点击“恢复”应用到本机', cacheCleared: '已清理本机缓存', clearFailed: '清理失败：{message}', backupMissing: '备份不存在或已损坏', restoredLocal: '已从备份恢复（仅本机）', restoreFailed: '恢复失败：{message}', backupExported: '已导出备份', exportFailed: '导出失败', backupDeleted: '已删除备份', deleteFailed: '删除失败', settings: '设置', approximately: '约 {size} KB'
    },
    ai: {
        analysisFailed: '分析失败'
    }
};
