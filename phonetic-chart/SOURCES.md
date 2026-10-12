# 录音与教学内容来源

## 英音

下载自 https://github.com/xiaozhah/phoneme_audio 的 audio/<IPA>_isolation.mp3，按原项目的音标文件名映射。其 README 标注录音来自 Oxford Dictionary：https://oalecd10.cp.com.cn/#/desktop/dict 。原文件内容未改动，仅重命名成本项目稳定 ID。

这是二次来源标注，未独立验证原始出版版本，未找到允许再分发的音频授权；不能因 GitHub 公开可读便视为开放许可。

## 美音

来源 https://soundsamerican.net/ 的公开 IPA chart。

- 映射：https://soundsamerican.net/data-ipa-chart/ipa-chart.json
- 原始录音：https://soundsamerican.net/data-ipa-chart/phonemes.mp3
- 每项使用官网播放器一致的 id 秒偏移、1 秒片段，转为独立 MP3。没有使用变速或音高变化。
- 保留其音标写法和例词，仅筛选本版需要的基础条目。

未取得再分发授权；版权仍归原权利人。

## 本版边界

当前仅为用户要求的个人本地评估版本，未部署或上传。公开发布、分发或整合进正式产品前，需获得明确许可或换成自有授权录音。两个来源讲者不同，音色和响度可能不同。自动检查能确认文件有效，不能替代合格语音教师逐项听审；本版不宣称已通过专业发音审核。

## 标注参考

IPA：https://www.internationalphoneticassociation.org/content/ipa-chart
Cambridge 符号与英美差异：https://dictionary.cambridge.org/help/phonetics.html

Cambridge 公开媒体地址在本次网络测试返回 403，因此没有将其作为本版播放来源。

后续建议使用同一位英音教师与同一位美音教师录制整套素材，审查孤立辅音是否附带元音、双元音过渡、口音一致性，再单独录制自然例词。音素示范不能直接拼接成自然单词发音。

## 统一显示层（本次更新）

参考 Oxford Advanced Learner’s Dictionary，而非强制所有词典采用统一转写。

- 指南：https://www.oxfordlearnersdictionaries.com/us/about/english/pronunciation_english.html
- bird：https://www.oxfordlearnersdictionaries.com/us/definition/english/bird_1
- teacher：https://www.oxfordlearnersdictionaries.com/definition/english/teacher

源数据 window.PHONEMES 保持原始符号、录音和例词。window.PHONEME_CARDS 按明确的对应关系生成教学显示，另存 sourceSymbol、sourceExample、sourceId 与 aliases。主显示符号转换不能被解释为逐字拼接发音。未更换或重新合成任何录音。

英音 /ɒ/ 的 sock 卡与 /ɑː/ 的 father 卡都可引用同一段美音 /ɑ/ 示范；teacher 的英音末尾使用原 /ə/ 示范。这是同一个示范音用于多个例词，不是新增音素。最初 /ɪr/、/er/、/ʊr/ 只提供对应标注；最新补录状态见下文。

## 卡通舌位示意（七组预览）

图形用原创 SVG 路径绘制，未复制来源网站的图片、动画或 MRI。参考资料用于确认基本发音描述；来源站点不背书本项目图形。

- Seeing Speech, University of Glasgow：IPA 发音影像与英语 r/l 变体。
  https://www.seeingspeech.ac.uk/ipa-charts/
  https://www.seeingspeech.ac.uk/r-and-l-in-english/?type=r
- Geoff Lindsey：The British English vowel system（现代标准南部英音，不能推广为全部英国口音）。
  https://www.englishspeechservices.com/blog/british-vowels/
- Sounds American：Vowel sound /ɪ/ as in it。
  https://soundsamerican.net/article/vowel_sound_lax_i_as_in_it
- Essentials of Linguistics：2.6 Classifying Consonants。
  https://pressbooks.pub/essentialsoflinguistics/chapter/2-7-classifying-consonants/

图中位置为定性示意，不按毫米或声学数据定位。r 的侧面图省略两侧舌缘抬起，不能将任何一图称为唯一正确舌形。/aɪ/ 的起点、终点只示意滑动方向。/æ/ 以常见口音趋势提供两图，和当前录音并非同人同步采集。尚无专业教师审图记录。


### 2026-10-10 图示核查

核对了 Essentials of Linguistics 的发音器官、元音、辅音、双元音章节，以及 Seeing Speech 的英语 r 类型说明。资料支持发音原则，未据 MRI 逐帧描摹，也未验证本项目每条 SVG 轮廓。

- 器官：https://pressbooks.pub/essentialsoflinguistics/chapter/2-3-articulators/
- 元音：https://pressbooks.pub/essentialsoflinguistics/chapter/2-8-vowels/
- 双元音：https://pressbooks.pub/essentialsoflinguistics/chapter/2-8-diphthongs/
- r 类型：https://www.seeingspeech.ac.uk/r-and-l-in-english/?type=r

修正：上方标注具体为硬腭；上门牙引线指向牙体中央；r 唇部引线调整；张口元音的正面唇形不再近似闭口；aɪ 不再标为固定终点；明确 tip-up 与 retroflex 不等同。英美 æ 的图形对比不能视为当前录音者的实际舌位。

未解决的专业验证：咽部、软腭、舌根轮廓及整体解剖比例仅为自绘简化；未显示完整鼻腔、喉部和横向舌形。全套图标为“动作草图，待语音专业审核”。不得以功能测试通过作为语音学验证通过。正式教学素材需要语音学教师核对对应录音、器官关系与每个发音的图形。


### 2026-10-11 全套结构重画与复核

Antigravity 按主代理列出的结构问题重画全部九张 SVG。主代理分别渲染查看 ae-uk、ae-us、dental、fleece、kit、price-start、price-end、r-bunched、r-retroflex，不以代理报告或测试通过代替看图。

本轮实际修改：分开咽后壁与舌根，气道延伸至下方裁切处；软腭改为抬起，区分硬腭与软腭；打开上下唇之间的口裂；r 的舌根与舌身重画、去除无实际几何依据的收窄圈；保留元音前后高低对比和齿音狭缝。r-retroflex 文件名为兼容旧接口保留，显示内容是 tip-up 示例，不主张所有抬舌尖都是 retroflex。

核对依据仍为本文件前列的教材器官/元音/辅音章节与 Seeing Speech r 类型资料。检查尺度是定性发音关系及图形一致性，不是人体精密比例、对应录音的实时影像或外部语音专家审定。页面继续保留此区别。


第二轮复核又移除了标题/腭部标签重叠、口内说明遮挡；补画齿音正面门牙与舌尖；iː 改为轻展双唇并调整舌尖靠近下门牙；aɪ 使用“滑向附近”而非固定终点；嘴唇引线落在轮廓实际点。主代理重新分别查看最终九张渲染图，并清除 r 两图残留的重复说明文字。定性构音示意检查完成，独立专业审图仍未完成；两者不等同。


### 新增 f/v/w、l、ʊ/uː 与气流说明

构音原则依据 Essentials of Linguistics 的辅音与元音章节：f/v 为唇齿擦音，w 为唇软腭近音，l 为齿龈边近音。补充 Seeing Speech 的 l 变体资料：https://www.seeingspeech.ac.uk/r-and-l-in-english/?type=l 。清晰/暗 l 因口音、语音环境变化；俯视图的双侧箭头是侧向通道示例，并非所有人一定左右等量通气。

/ʊ uː/ 采用传统定性对比图并明确非英美通用精确位置；Geoff Lindsey 的 British English vowel system 描述现代标准南部英音 FOOT/GOOSE 的前移和变化，不能把偏后舌位示意当作所有当代英音的唯一标准。

外箭头改为“呼气方向”，避免被误读为内部气流路线；摩擦部位单独标识，l 通过第二视角说明侧向气流。当时整词播放采用明确标注的设备合成音；现已改为下文所述真人词典录音。

主代理逐张渲染检查六幅新图及更新的齿音图；修正 l 俯视箭头穿过舌体的问题，移至侧边通道，并修正通气道与 ʊ 舌位引线、uː 的过度用力提示及上牙标注。外箭头与呼气方向标牌重新对齐。

## 本次补录、例词播放与第三组配图

重新直接获取 Sounds American 的 ipa-chart.json，确认原音频包含 id=45 /ɪr/ (hero)、id=46 /ɛr/ (chair)。原来的 41 段只是项目筛选数量，不是上游素材总数。分别取原 phonemes.mp3 的 45/46 秒开始各 1 秒，方法与旧素材一致；没有拼接或改音高。源符号 /ɛr/ 保留，学习显示 /er/。文件可解码且非静音，不等同于独立专业听审。仍沿用现有音标音源的个人本地评估与未获再分发授权边界。

/ʊr/ 不在该来源列表中。另查 Oxford American pronunciation guide 与 aepronunciation lesson 5，确认有该读法和单词示例，但未取得并核验可直接使用的孤立音示范。因此保留“独立示范待补”，提供 pure 的完整单词试听（现已改用真人录音），不截去整词辅音来伪造独立示范。

- https://soundsamerican.net/data-ipa-chart/ipa-chart.json
- https://soundsamerican.net/data-ipa-chart/phonemes.mp3
- https://www.oxfordlearnersdictionaries.com/us/about/pronunciation_american_english
- https://www.aepronunciation.com/lessons/lesson-5/

前一阶段例词通过浏览器 Web Speech API 朗读完整英文词，使用精确 en-GB 或 en-US voice，界面标明“合成”。未把 IPA 输入合成器充当音标示范，也未引入未确认许可的词典整词音频。该阶段播放品质及实际口音取决于设备 voice；平台标签不等于已由教师审听。此实现现已移除，不再作为自动回退。

- https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis/getVoices
- https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis/voiceschanged_event

新增 /e n ŋ s ʃ tʃ/ 的构音描述依据 Essentials of Linguistics 元音和辅音章节及 Seeing Speech IPA 示范：鼻音口腔闭塞、鼻腔开放；齿龈与齿龈后擦音区分收窄位置；塞擦音有相连的闭塞和摩擦释放阶段。自绘图形不是资料原图，参考来源不对本项目背书。

主代理逐张渲染检查本轮全部七张新图，修正鼻腔标签指向轮廓外、鼻孔出口、ŋ 舌后接触面及标注遮挡、s 窄缝不清楚、tʃ 闭塞图将“气流受阻”画进舌体等问题；移除该错误流线，保留紫色舌位动作方向。同步修正橙色既用于接触也用于摩擦的图例，以及两张 tʃ 的 SVG 无障碍描述引用。仍为定性构音核查，不宣称已完成专业审图。


## 2026-10-11 完整例词真人录音与整词音标

63 个例词及对比词，每词分别取得 Oxford Learner's Dictionaries 的 British English 与 North American English 完整单词 MP3，共 126 段；文件原样保存到 audio/words/uk 与 audio/words/us，没有从整词截取音标，没有变速或变调。she、we 从同一词条明确选择 strong form 的录音和对应音标，而非把 weak form 音标改成长音。录音地址分别含 uk_pron 与 us_pron。

word-audio.js 为逐项来源清单，保存 sourceUrl、sourceAudio、sourceIPA、学习显示 ipa、原始音频 sha256 与时长。播放器使用本地文件，缺失时提示“待补”，不再退回设备合成音。没有宣称宽式音标相同就声音完全相同，也没有为了显出差异而重写共同音标。

标注处理：英音独立例词去掉词典的可选连接 (r)，但保留原始 sourceIPA；美音 nose、go 的 Oxford 原词条显示沿用 əʊ，学习界面根据 Cambridge 的口音对照改为 oʊ，并逐项保存 ipaReference。音频本身仍为 Oxford 的 North American 录音。

- Oxford nose 原词条：https://www.oxfordlearnersdictionaries.com/definition/english/nose_1
- Cambridge nose 校对：https://dictionary.cambridge.org/pronunciation/english/nose
- Cambridge go 校对：https://dictionary.cambridge.org/pronunciation/english/go
- Oxford she 强弱读：https://www.oxfordlearnersdictionaries.com/definition/english/she
- Oxford we 强弱读：https://www.oxfordlearnersdictionaries.com/definition/english/we

版权及使用范围：来源为公开可访问词典资源，但公开访问不是产品再分发许可。当前仅按用户要求保留在个人本地评估项目，未发布、未并入 bdc。未取得这些词典录音的再分发授权，正式产品需另行获得许可或换为自有授权素材。自动校验来源、哈希与可解码性，不能替代专业语音教师逐词听审。

## 2026-10-11 新增双元音滑动图

新增 /eɪ/、/əʊ～oʊ/、/aʊ/、/ɔɪ/ 四组动作示意，起点和滑向位置采用连续两帧。GOAT 的英美起点分开，其余用共有定性方向；共享滑向图不声称英美终点完全一致。没有要求结尾必须到达完整独立的 /ɪ/ 或 /ʊ/，也没有模拟与当前示范录音精确同步。

构音原则参考 Catherine Anderson, Essentials of Linguistics 的双元音章节（正文以 Canadian English 为例）及 Geoff Lindsey 的常见现代英音说明。资料用于描述方向和口音变化，未复制其图像。

- https://pressbooks.pub/essentialsoflinguistics/chapter/2-8-diphthongs/
- https://www.englishspeechservices.com/blog/british-vowels/

9 张新 SVG 由 Antigravity 在既有风格内绘制，构音内容由主代理配置；续接验收已逐张渲染核对器官标签、舌位变化与开放气道；下门牙标注通过图形坐标检查。该检查属于定性教学图复核，不等同于专业语音审图。独立专业语音审图仍未完成。


## 2026-10-11 续接验收

- 修复英美双行例词按钮的事件绑定：英音行固定播放 UK，新增美音行的点击处理并固定播放 US；不随当前详情口音串音。切卡后读取新例词。
- 新增两项回归测试，先在旧代码复现“美音按钮无事件”和“英音按钮误播美音”，修复后通过。全套 36 项自动检查通过。
- 126 段真人整词 MP3 全部通过 ffmpeg 解码检查；来源、哈希与两种口音覆盖由既有测试校验。未将可解码性等同于专业听审。
- 本轮渲染查看 face、goat、mouth、choice 共 9 张 SVG，检查标签落点、起点与滑向差异、呼气与舌位箭头区分。专业语音教师逐图审核仍待完成。
- 本地预览服务 HTTP 200。本轮浏览器控制工具不可用，未完成真实浏览器点击和移动端视觉回归；新增按钮验收为模拟 DOM 事件回归，不冒充浏览器实测。


## 2026-10-11 六个塞音、阶段切换与对比例词

三个部位的两阶段 SVG 为本轮原创定性示意，成对音共享位置图，声带与送气说明独立。绘图标注依据香港教育大学的塞音部位说明；闭塞图不带向外箭头，释放图的箭头只指口外方向，不表示声带或送气强弱。避免把 /b d ɡ/ 教成闭塞全程必然振动，也不要求词尾总要明显释放。

- https://corpus.eduhk.hk/english_pronunciation/index.php/3-2-acoustic-aspects-of-consonants/
- https://ecampusontario.pressbooks.pub/essentialsoflinguistics/chapter/3-5-aspirated-stops-in-english/

pin、bin、ten、den、coat、goat、spin 共 14 段英美录音取自各 Oxford 词条，原始 URL、IPA、时长与 SHA-256 保存在 word-audio.js。沿用原项目的本地评估范围。coat、goat 的美音学习显示依 Cambridge 使用 /oʊ/，保留 Oxford 原始 /əʊ/ 记录，不改变录音。

- https://dictionary.cambridge.org/us/pronunciation/english/coat
- https://dictionary.cambridge.org/pronunciation/english/goat

六图已渲染查看标签与闭塞／释放差异；新增录音通过解码。44 项自动回归通过，包含真实 UI 函数在模拟 DOM 中的阶段切换、成对跳转、口音保持；这不是浏览器或手机实测。专业语音听审与审图仍待完成。


## /z ʒ dʒ/ 配图补充（2026-10-11）

- 原创图沿用本项目 s、ʃ、tʃ 的口腔轮廓，另存为 z.svg、zh.svg、j-closure.svg、j-release.svg，并明确浊音与声带未画出。不是录音者的实际舌形。
- 发音部位、摩擦与清浊参考：https://pressbooks.pub/essentialsoflinguistics/chapter/2-7-classifying-consonants/ ；影像参考入口沿用 https://www.seeingspeech.ac.uk/ipa-charts/ 。
- /dʒ/ 两帧用于示意同一个塞擦音；不要求闭塞全程持续声带振动。
- 例词复用已记录的 sip、zoo、she、vision、cheese、jump 英美真人录音及音标；不是最小对立词组，无新增音频来源。


## /m j h/ 配图补充（2026-10-11）

原创 SVG 沿用项目塞音图的视觉样式。/m/ 为双唇鼻音，/j/ 为硬腭近音，/h/ 为声门音；核查参考 https://pressbooks.pub/essentialsoflinguistics/chapter/2-7-classifying-consonants/ 。图示是定性教学草图，/j/ 仅画起始姿势，/h/ 不主张固定口腔形状且未画声门。专业审核未完成。

例词复用现有真人录音及来源记录，无新增外部音频。


## /ɑː ʌ ɔː ɒ/ 配图补充（2026-10-11）

原创 SVG 沿用本项目侧面示意样式，增加正面唇形小图。元音高度、前后及圆唇参考：https://pressbooks.pub/essentialsoflinguistics/chapter/2-8-vowels/ 。现代英音 LOT、NORTH 与 STRUT 的变化参考：https://www.englishspeechservices.com/blog/british-vowels/ 。

图中为定性参考，尤其 /ɒ/ 采用较低舌位示意，不表示现代英音必须达到该位置。sock 英美对应与美音合并说明沿用已有词典与音标来源记录。无新增录音。


## 中央元音与 r 色彩元音配图（2026-10-11）

中央元音图为原创定性示意，参考 https://pressbooks.pub/essentialsoflinguistics/chapter/2-8-vowels/ ；r 色彩图沿用本项目 r-bunched.svg 口腔几何，改为元音专用标题、描述与提示。舌身隆起及其他可选舌形参考 Seeing Speech 的 Schwar、Bunched r、Tip up r：https://www.seeingspeech.ac.uk/r-and-l-in-english/?type=r 。

重读 /ɝ/ 与弱读 /ɚ/ 在学习界面沿用 /ɜːr/ 与 /ər/ 标记，配图不主张固定时长或两个独立音段。teacher、bird、about 沿用现有词典真人录音及音标，无新增音源。专业审核未完成。


## NEAR / SQUARE / CURE 英美对应（2026-10-11）

五张新增 SVG 基于项目 kit、e、foot、r 色彩图的原创几何调整并重写阶段标签。英音展示传统向中央过渡方向，同时保留现代英音单元音化及 CURE 变化说明，参考 https://www.englishspeechservices.com/blog/british-vowels/ 。美音 r 色彩可选舌形参考 https://www.seeingspeech.ac.uk/r-and-l-in-english/?type=r 。

图示非固定终点，轮播与录音不同步。ear、hair、pure 复用现有词典来源；没有新增或合成 /ʊr/ 独立录音。专业审核仍待完成。


## /ʊr/ 音源续查（2026-10-11）

检查 https://www.aepronunciation.com/lessons/lesson-5/ 及 Sounds American 的 OUR 说明，未取得已核验的独立真人录音，保留缺失提示。现有 pure 整词音源不改作独立音源。续查及审核清单见 REVIEW.md。

## /ʊr/ 独立示范已接入（2026-10-11）

- 讲者：Julie Cunningham, MA, CCC-SLP；San Diego Voice and Accent。
- 官方教程：https://sandiegovoiceandaccent.com/american-english-vowels/how-to-pronounce-the-oor-%CA%8A%C9%B9-vowel
- 原视频：https://www.youtube.com/watch?v=JEKYr4WRY88&t=23 （2020-08-23）。
- 原始标注 /ʊɹ/，学习显示 /ʊr/；原例词 tour，卡片继续用 pure。
- 截取 23.65–24.65 秒连续片段，位于 you're 词例之后、下一句 I just described 之前，逐字稿该处为独立 OOR。字幕定位 ur 在 23.760 秒，下一句在 25.119 秒；静音检测确认前后留白。
- 文件 audio/us/us-ur.mp3，单声道 44.1 kHz、128 kbps；仅裁切与转码，无拼接、变速、音高调整或合成。
- 文件 SHA-256：e12549d4bef6f560d2d4daf58b5ef159c97c5e888c2dcb9bc2b3f05ddf67b70d。
- 已核对官方逐字稿、字幕时间轴、画面音标和静音边界；尚未完成专业人工听审。版权及个人本地评估范围沿用本文前述边界。


## 在线补齐试验（2026-10-12）

使用 Free Dictionary API https://dictionaryapi.dev/ 的 `/api/v2/entries/en/{word}`。仅采用同一 phonetics 对象中绑定的 text/audio，保留 sourceUrl 与 license 字段；页面显示音频原始来源链接和许可名称。录音由本地固定域名转发服务读取，不修改波形、不拼接成单词。

实测 live/lead 有美音配对，read 查询返回错误或超时；音频转载地址亦有超时。本次验证不构成可用性或口音覆盖保证。未接入 Oxford 付费 API，未使用网页抓取补齐，也未将不同读音混用。
