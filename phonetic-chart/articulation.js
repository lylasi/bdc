(() => {
  'use strict';
  const references = {
    diphthongs: {title:'Essentials of Linguistics：连续变化的双元音',url:'https://pressbooks.pub/essentialsoflinguistics/chapter/2-8-diphthongs/'},
    vowels: {title:'Essentials of Linguistics：元音的发音',url:'https://pressbooks.pub/essentialsoflinguistics/chapter/2-8-vowels/'},
    lateral: {title:'Seeing Speech：英语 l 的不同舌形',url:'https://www.seeingspeech.ac.uk/r-and-l-in-english/?type=l'},
    ipa: {title:'Seeing Speech：发音影像参考', url:'https://www.seeingspeech.ac.uk/ipa-charts/'},
    british: {title:'Geoff Lindsey：现代英音元音', url:'https://www.englishspeechservices.com/blog/british-vowels/'},
    kit: {title:'Sounds American：/ɪ/ 的发音', url:'https://soundsamerican.net/article/vowel_sound_lax_i_as_in_it'},
    dental: {title:'Essentials of Linguistics：辅音的发音部位', url:'https://pressbooks.pub/essentialsoflinguistics/chapter/2-7-classifying-consonants/'},
    rhotic: {title:'Seeing Speech：英语 r 的多种舌形', url:'https://www.seeingspeech.ac.uk/r-and-l-in-english/?type=r'}
  };
  const frame = (name, label, alt) => ({asset:`assets/articulation/${name}.svg`,label,alt});
  const anatomyReference = {title:'发音器官位置：Essentials of Linguistics', url:'https://pressbooks.pub/essentialsoflinguistics/chapter/2-3-articulators/'};
  const commonNote = '动作草图，待语音专业审核：只帮助理解大致动作；轮廓不按解剖比例，也不对应当前录音者。未完整展示鼻腔、喉部和三维结构。';
  const profiles = {
    'eɪ': {
      title:'从中前舌位，连续滑向较高的位置', mode:'sequence',
      summary:'舌前部先抬到中间位置，随后继续抬高，嘴渐渐收小。声音一直连着，双唇保持不圆。',
      voicing:'声带振动', lipHint:'从自然的小开口变得更小，不用使劲咧嘴。',
      airflow:'两帧之间气流持续从口腔通过；舌面始终不封住上腭。蓝色箭头只表示向口外呼气，紫色指舌位变化。',
      contrast:'听 day、say 的元音变化。滑向 /ɪ/ 附近，结尾通常较轻，别把两个位置读成两个音节。',
      note:commonNote + ' 示意采用常见滑动方向；实际起点与幅度随口音、语境变化，结尾不要求达到独立 /ɪ/ 的精确位置。',
      frames:[frame('face-start','① 起点 · 中前舌位','eɪ 起点：舌前部在中间高度，双唇自然不圆，口腔气道开放。'),frame('face-end','② 滑向 · 舌前部较高','eɪ 滑向：舌前部比起点更高，开口较小，保持连贯发声，不将两帧发成两个音节。')],sources:[references.diphthongs,references.british]
    },
    'aʊ': {
      title:'从张开，连续滑向拢圆的嘴唇', mode:'sequence',
      summary:'嘴先张开，舌位较低，再把舌位抬高一些并向后调整，双唇逐渐收拢。动作和声音连成一段。',
      voicing:'声带振动', lipHint:'起点开口较大、不圆；随后逐渐拢圆，别突然换口型。',
      airflow:'元音从头到尾保持口腔通气。紫色箭头示舌位变化，嘴外蓝色箭头仅示呼气方向。',
      contrast:'听 mouth、cow 的元音，从较开的音色连续变化到较收拢的音色；不要加额外的“呜”音节。',
      note:commonNote + ' 实际舌位与滑动幅度随口音变化；图示只说明低到较高、逐渐圆唇的趋势，不规定固定终点。',
      frames:[frame('mouth-start','① 起点 · 舌位低、嘴张开','aʊ 起点：舌位较低，双唇张开、不圆，气流从口腔通过。'),frame('mouth-end','② 滑向 · 舌位抬高、双唇拢圆','aʊ 滑向：舌位比起点高并偏后，嘴渐收小、双唇圆一些，舌面仍留通气间隙。')],sources:[references.diphthongs,references.british]
    },
    'ɔɪ': {
      title:'从后部圆唇，连续滑向前部不圆唇', mode:'sequence',
      summary:'起点舌位在后部、中间偏低，双唇圆一些。随后舌位向前、向上移动，双唇放开、不再拢圆。',
      voicing:'声带振动', lipHint:'从较圆的嘴唇渐渐放开，结尾开口通常比起点小。',
      airflow:'气流连续经口腔流出，舌面不碰上腭。两帧表示同一元音的连续变化，不是先停气再重新开始。',
      contrast:'听 boy、toy：从后部圆唇的音色滑向 /ɪ/ 附近，结尾较轻，不要分读成两个音节。',
      note:commonNote + ' 示意为常见方向，不表示英美每位说话人相同的毫米舌位，也不要求结尾是完整独立的 /ɪ/。',
      frames:[frame('choice-start','① 起点 · 后部舌位、圆唇','ɔɪ 起点：舌位在口腔后部、中间偏低，双唇拢圆，气道开放。'),frame('choice-end','② 滑向 · 前部较高、双唇放开','ɔɪ 滑向：舌位向前上方调整，双唇不圆，开口收小，气流持续通过。')],sources:[references.diphthongs,references.british]
    },
    e: {
      title:'舌前部抬起，比 /æ/ 开口小一些', mode:'single',
      summary:'双唇自然、不拢圆，舌前部抬到中间偏低的位置。和 /æ/ 比，通常舌位更高、嘴张得小一些。',
      voicing:'声带振动', lipHint:'嘴自然张开，不用使劲咧嘴。',
      airflow:'口腔通道开放，气流平顺流出。嘴外箭头只表示呼气方向。',
      contrast:'对照 bed–bad，听 /e–æ/ 的音色变化，不要只靠张嘴大小判断。',
      note:commonNote + ' 页面采用 /e/，美音资料也常写 /ɛ/；这不是要求发成另一个更高的元音。',
      frames:[frame('e','前部中低舌位','舌前部抬起，比 ae 示意更高，舌面不封闭口腔气道。')],sources:[references.vowels,references.british]
    },
    n: {
      title:'舌尖轻贴齿龈，气从鼻子走', mode:'single',
      summary:'舌尖轻贴上门牙后面的齿龈，封住口腔前方。软腭放下，边发声边让气流通过鼻腔。',
      voicing:'声带振动', lipHint:'嘴唇不必闭紧，闭塞发生在舌尖与齿龈之间。',
      airflow:'口腔前方被舌尖封住；软腭降低后，咽部与鼻腔相通，气流从鼻孔出去。蓝线表示简化通路，不是穿过舌头。',
      contrast:'对照 sin–sing：/n/ 用舌尖在前方闭塞，/ŋ/ 用舌后部在后方闭塞。',
      note:commonNote + ' 鼻腔仅画通路，不表示完整鼻部结构。',
      frames:[frame('n','齿龈鼻音','舌尖接触齿龈、软腭降低，气流从咽部进入鼻腔并从鼻孔流出。')],sources:[references.dental,references.ipa]
    },
    'ŋ': {
      title:'舌后部抬起，气从鼻子走', mode:'single',
      summary:'舌后部抬起接触软腭，封住口腔后方；舌尖不用顶齿龈。鼻腔通路打开，持续发声。',
      voicing:'声带振动', lipHint:'嘴唇自然，重点是舌后部的位置。',
      airflow:'舌后部与软腭接触，阻断通向嘴的气流；软腭仍保持鼻腔入口开放，气流经鼻腔流出。',
      contrast:'对照 sin–sing。练 sing 词尾的 /ŋ/，不要额外加一个 /g/ 或“呃”。',
      note:commonNote + ' /ŋ/ 不等于 /n/ 加 /g/；是否有后续 /g/ 要看具体单词。',
      frames:[frame('ng','软腭鼻音','舌后部接触降低的软腭，口腔后方闭塞，咽部至鼻腔的气道仍开放。')],sources:[references.dental,references.ipa]
    },
    s: {
      title:'舌前部靠近齿龈，留一条窄缝', mode:'single',
      summary:'舌尖或舌叶靠近齿龈，中央留出细小通道，持续送气。不要完全堵住，也不要把舌尖伸到牙齿之间。',
      voicing:'声带不振动', lipHint:'双唇自然，牙齿靠近但不咬紧。',
      airflow:'气流经舌前部中央的窄通道形成摩擦；橙色标出靠前的摩擦位置，侧面图省略了中央沟槽的宽度。',
      contrast:'对照 sip–ship，/s/ 的收窄部位一般比 /ʃ/ 更靠前。',
      note:commonNote + ' 舌尖可略抬或向下，图示只是一种方式，不要求每个人固定成同一舌形。',
      frames:[frame('s','齿龈附近的摩擦','舌前部与齿龈之间留窄缝，非完全接触；软腭抬起，气流从口腔流出。')],sources:[references.dental,references.ipa]
    },
    'ʃ': {
      title:'收窄位置往后一点，持续送气', mode:'single',
      summary:'舌前部靠近齿龈后方，留出窄通道持续送气。双唇可以略收拢，不要用力噘嘴。',
      voicing:'声带不振动', lipHint:'可略收拢，程度会随前后元音变化。',
      airflow:'气流在齿龈后方的窄通道形成摩擦，没有先完全堵住的步骤；与 /s/ 比，收窄位置一般更靠后。',
      contrast:'对照 sip–ship，再比 ship–chip：/ʃ/ 可以持续摩擦，/tʃ/ 先闭塞再释放。',
      note:commonNote,
      frames:[frame('sh','齿龈后方的摩擦','舌前部与齿龈后方之间保持窄缝，橙色标出摩擦部位，舌面不完全封闭通道。')],sources:[references.dental,references.ipa]
    },
    'tʃ': {
      title:'先堵住，再连贯地擦着放开', mode:'sequence',
      summary:'舌前部先接触齿龈后方，短暂封住气流；随后打开窄缝，带着摩擦释放。两步连成一个塞擦音，中间不加元音。',
      voicing:'声带不振动', lipHint:'可以稍收拢，随单词的其他音自然变化。',
      airflow:'第一步口腔闭塞、鼻腔通路关闭，没有向外呼气箭头；第二步打开窄缝，气流经摩擦部位向口外释放。',
      contrast:'对照 ship–chip：chip 的开头有短暂闭塞；不要念成两段“特、诗”。',
      note:commonNote + ' 两帧是同一塞擦音的先后动作，不表示两个分开的音节。',
      frames:[frame('ch-closure','① 短暂闭塞','舌前部接触齿龈后方，软腭抬起，口腔与鼻腔的出气通路均暂时被阻断。'),frame('ch-release','② 摩擦释放','舌前部稍离开接触面，形成窄缝并释放气流，动作与第一步连续衔接。')],sources:[references.dental,references.ipa]
    },
    f: {
      title:'上牙轻触下唇，轻轻送气', mode:'single',
      summary:'上门牙轻靠下唇，留出小缝送气。别咬紧，也不用把舌尖伸出来。',
      voicing:'声带不振动', lipHint:'看上牙与下唇的接触，嘴唇不用拢圆。',
      airflow:'气流经过上门牙与下唇的小缝形成摩擦。橙色标记指出摩擦位置；嘴外蓝箭头只表示呼气方向。',
      contrast:'对照 /v/：牙唇位置相近，/f/ 不振动声带，/v/ 加上声音。例词 fan–van。',
      note:commonNote,
      frames:[frame('labiodental','上牙与下唇','侧面及正面示意：上门牙轻靠下唇，橙色标记指出摩擦位置，口外蓝箭头仅表示向外呼气。')],sources:[references.dental]
    },
    v: {
      title:'保持牙唇位置，加上声音', mode:'single',
      summary:'上门牙轻靠下唇，边送气边发声。不要把下唇移开改成拢唇的 /w/。',
      voicing:'声带振动',lipHint:'下唇轻靠上门牙，别咬紧。',
      airflow:'与 /f/ 一样，气流在上牙和下唇之间形成摩擦；/v/ 还伴随声带振动。',
      contrast:'先比 fan–van 的 /f–v/，再比 vest–west 的 /v–w/：/v/ 牙唇接触，/w/ 拢唇。',
      note:commonNote,
      frames:[frame('labiodental','相近牙唇位置，声带振动','上门牙轻靠下唇形成摩擦，和 /f/ 共用部位示意；声带是否振动由文字标记区分。')],sources:[references.dental]
    },
    w: {
      title:'先拢唇，滑向后面的元音', mode:'single',
      summary:'双唇先收拢，舌后部同时抬高但不堵住气流，然后顺势滑向后面的元音。',
      voicing:'声带振动',lipHint:'双唇收拢，上牙不要压住下唇。',
      airflow:'双唇和舌后部使通道收窄，但气流平顺通过，不练成 /v/ 那样的牙唇摩擦。',
      contrast:'对照 /v/：vest–west、vine–wine。看清 /v/ 的牙唇接触和 /w/ 的拢唇动作。',
      note:commonNote + ' 图示为起始姿势；/w/ 会随后面的元音改变，不能一直保持同一口型。',
      frames:[frame('w','拢唇与舌后部抬高','侧面及正面示意：双唇拢圆，舌后部抬高形成近音通道；牙齿不压下唇。')],sources:[references.dental]
    },
    l: {
      title:'舌尖碰齿龈，气流走旁边', mode:'views',
      summary:'练习清晰的 /l/：舌尖轻碰上门牙后面的小凸起，也就是齿龈，让气流从舌边通过。',
      voicing:'声带振动',lipHint:'嘴自然张开；不用像 /r/ 那样刻意收拢。',
      airflow:'前方中央有接触，气流从舌头一侧或两侧绕过。侧面图看不见横向通道，请对照俯视示意。',
      contrast:'对照已有 /r/：light–right。此处 /l/ 舌尖接触齿龈，所示 /r/ 舌尖或舌身中央不碰上腭。',
      note:commonNote + ' 两张图是同一发音的两个视角，不是先后步骤。先练清晰 l；词尾及不同口音可出现舌后部抬高的暗 l 或其他变体，不要求照搬此舌形。',
      frames:[frame('l-side','侧面：舌尖接触齿龈','清晰 l 的侧面示意：舌尖接触上门牙后齿龈，中央前方受阻；气流不是穿过接触点。'),frame('l-top','俯视：气流绕过舌边','从上方看的示意：标出嘴前方与后方，气流沿舌侧绕过中央接触区向嘴外流出；两侧箭头仅为一种示例。')],sources:[references.dental,references.lateral]
    },
    'ʊ': {
      title:'舌位稍低，嘴唇放松', mode:'single',
      summary:'与图中的 /uː/ 相比，舌位稍低、稍偏中央，嘴唇轻轻拢圆而不必使劲往前撅。',
      voicing:'声带振动',lipHint:'轻拢双唇，保持放松。',
      airflow:'气流从口腔通畅流出，没有牙唇摩擦，也没有完全堵住的部位。',
      contrast:'对照 /uː/：full–fool、pull–pool。先听音色，再看舌位和唇形；不是只把同一个音缩短。',
      note:commonNote + ' 不同口音的前后位置和圆唇程度会变化；图示只表达一组教学对比。',
      frames:[frame('foot','较低、较放松的圆唇元音','侧面及唇形示意：与 uː 参考图相比，舌位稍低、较偏中央，唇形较放松，气道保持开放。')],sources:[references.vowels,references.british]
    },
    'uː': {
      title:'舌位较高，双唇收拢', mode:'single',
      summary:'舌位抬高，双唇收拢，气流不断。图中采用偏后舌位的入门示意，不用使劲把舌头往后缩。',
      voicing:'声带振动',lipHint:'双唇收拢，程度跟随示范，不要绷紧。',
      airflow:'气流经过收窄但未堵塞的口腔通道，从双唇之间平顺流出；不产生 /f、v/ 式摩擦。',
      contrast:'对照 /ʊ/：full–fool、pull–pool。留意音色与唇形，不要仅凭长短判断。',
      note:commonNote + ' 现代英美口音中这个元音常有舌位前移；这张图不代表所有口音或当前录音者的确切舌位。',
      frames:[frame('goose','高位圆唇元音的一种示例','侧面及正面示意：较高、偏后的参考舌位配合拢唇，舌面不封闭气道；真实口音可能比图示靠前。')],sources:[references.vowels,references.british]
    },

    'iː': {
      title:'舌前部抬高', mode:'single',
      summary:'舌前部向上抬，靠近上腭但不堵住气流；舌尖自然靠近下门牙。',
      voicing:'声带振动', lipHint:'嘴唇轻轻向两边展开，不必用力咧嘴。',
      note:commonNote + ' /iː/ 与 /ɪ/ 的区别还包括音色，不能只靠拖长或缩短。',
      frames:[frame('fleece','前高元音','侧面示意：舌前部抬高，舌面与上腭之间保留气道；小图为轻展的双唇。')], sources:[references.ipa,references.kit]
    },
    'ɪ': {
      title:'放松，比 /iː/ 稍低', mode:'single',
      summary:'舌头放松，舌前部的位置比 /iː/ 稍低、稍靠后，气流自然通过。',
      voicing:'声带振动',lipHint:'嘴自然微张，双唇放松，不拢圆。',
      note:commonNote + ' 对照 ship 和 sheep 的元音，听音色的区别。',
      frames:[frame('kit','放松的近高元音','侧面示意：舌前部抬起但低于 /iː/，口腔前方有更大的空隙；小图为放松的双唇。')],sources:[references.kit,references.ipa]
    },
    'θ': {
      title:'舌尖靠近牙齿，轻轻送气', mode:'single',
      summary:'舌尖轻放在上下门牙之间或上门牙边缘，让气流从窄缝中擦过，不要咬紧。',
      voicing:'声带不振动',lipHint:'嘴轻轻张开，舌尖可以露出一点点。',
      note:commonNote + ' 与 /ð/ 可以用相近舌位；这里主要练习不振动声带的送气。',
      frames:[frame('dental','舌尖与门牙','侧面示意：舌尖接近上下门牙间，橙色标记指向齿间摩擦位置，嘴外蓝箭头只表示呼气方向；唇形小图可见舌尖。')],sources:[references.dental,references.ipa]
    },
    'ð': {
      title:'保持齿间舌位，加上声音', mode:'single',
      summary:'舌尖轻靠门牙附近，留出气流通道；在这个位置轻轻发声。',
      voicing:'声带振动',lipHint:'与 /θ/ 相近，双唇自然张开，牙齿别咬紧。',
      note:commonNote + ' 可轻触自己的喉咙，感受 this 开头与 think 开头的区别。',
      frames:[frame('dental','相近舌位，声带振动','侧面示意：舌尖接近上下门牙间，气流向外；舌位与 /θ/ 相近，发声区别由声带振动标记说明。')],sources:[references.dental,references.ipa]
    },
    r: {
      title:'英语 r：两种舌形示例', mode:'alternatives',
      summary:'可以让舌身隆起，也可以抬起舌尖向后靠近。舌尖和舌身中央不顶住上腭，不弹动舌尖；舌根附近也参与收窄。',
      voicing:'声带振动',lipHint:'嘴唇可以稍微收拢，具体程度因说话人而异。',
      note:commonNote + ' 两张图是常见舌形的简化示例，不是全部类型，也不分别代表英音和美音。舌尖抬起不一定就是卷舌。侧面图省略了舌头两侧的抬起。',
      frames:[frame('r-bunched','方法 A · 舌身隆起','侧面示意：舌身向上隆起而舌尖不卷起，舌根附近收窄但仍留有气道。'),frame('r-retroflex','方法 B · 舌尖抬起','侧面示意：舌尖抬起并略向后靠近上腭但不接触，舌根附近收窄；不需要用力卷舌。')],sources:[references.rhotic]
    },
    'aɪ': {
      title:'从张开滑向较小的口型', mode:'sequence',
      summary:'嘴先张开、舌位较低，再连续滑向 /ɪ/ 附近；整个过程连成一个音，中间不停顿。',
      voicing:'声带振动',lipHint:'从较大的开口逐渐收小，双唇不拢圆。',
      note:commonNote + ' 箭头只表示动作方向；英美起点和滑动幅度可有差别，不必刻意到达两个固定位置。',
      frames:[frame('price-start','① 起点 · 嘴张开','侧面示意：舌头较低，嘴张开，为 /aɪ/ 的起始动作。'),frame('price-end','② 滑向 · 舌前部抬起','侧面示意：舌前部逐渐抬起向 /ɪ/ 附近靠近，张口幅度收小，与起点连贯衔接。')],sources:[references.ipa,references.british]
    }
  };
  const stopReference = {title:'香港教育大学：塞音部位、释放与送气',url:'https://corpus.eduhk.hk/english_pronunciation/index.php/3-2-acoustic-aspects-of-consonants/'};
  for (const [symbols, place, title, closure, release, words] of [
    [['p','b'],'bilabial','双唇先合，再打开','双唇轻轻合上，短暂挡住气流。','双唇打开，接着发后面的音。',['pin','bin','spin']],
    [['t','d'],'alveolar','舌前部先贴齿龈，再松开','舌尖或舌叶接触上门牙后面的齿龈，短暂闭塞。','舌前部离开齿龈，短暂释放气流。',['ten','den']],
    [['k','ɡ'],'velar','舌后部先贴软腭，再松开','舌后部抬起接触软腭，闭塞在口腔后方。','舌后部离开软腭，接着发后面的音。',['coat','goat']]
  ]) {
    symbols.forEach((symbol,index) => {
      profiles[symbol] = {
        title, mode:'sequence', sequenceLabel:'先闭塞 → 再释放', pairedSymbol:symbols[1-index],
        summary:closure + release + '两步是同一个塞音，不要在后面额外加“呃”。',
        voicing:index === 0 ? '声带不振动' : '浊音 · 振动时机随语境变化',
        lipHint:place === 'bilabial' ? '双唇接触后放开，不要用牙齿咬下唇。' : '嘴唇自然；闭塞点在舌头与上腭之间，不在双唇。',
        airflow:'闭塞时软腭抬起，鼻腔出口关闭，口腔也暂时不通气；释放时解除接触。蓝箭头只示口外呼气方向，不表示送气强弱。',
        contrast:`对照 ${words[0]}–${words[1]} 的开头：位置相同，听释放后的气声和进入元音的差别。` + (place === 'bilabial' ? '再听 pin–spin：同一音节中 /s/ 后的 /p/ 通常不送气，但没有变成 /b/。' : ''),
        note:commonNote + ' 此处展示词首的基本闭塞—释放动作。/p t k/ 在重读音节开头常送气，同一音节 /s/ 后通常不送气；/b d ɡ/ 不要求闭塞全程持续振动。词尾可能不明显释放，不要强行补爆破。',
        frames:[frame(`stop-${place}-closure`,'① 闭塞',closure+'鼻腔通路关闭。'),frame(`stop-${place}-release`,'② 释放',release+'与前一步连成一个动作。')],
        sources:[references.dental,stopReference]
      };
    });
  }
  // Voiced counterparts retain their own labels and teaching instructions.
  profiles.z = {
    ...profiles.s, title:'齿龈附近留窄缝，边摩擦边发声', pairedSymbol:'s',
    summary:'舌前部靠近齿龈，中央留一条窄缝。保持摩擦气流，同时轻轻发声；舌头不要先完全堵住。',
    voicing:'浊音 · 声带振动',
    contrast:'切换 /s–z/，先听独立音，再听 sip 的开头和 zoo 的开头。可轻触自己的喉咙感受发声差别，不要用力挤喉。',
    note:commonNote + ' /z/ 是持续摩擦音，不是先闭塞再释放的塞擦音；不要读成汉语拼音 z，也不要在后面加元音。自然语流中的振动程度会变化。',
    frames:[frame('z','齿龈摩擦 · 声带振动','z：舌前部与齿龈之间留窄缝，气流形成摩擦，同时发声；声带未画出。')]
  };
  profiles['ʒ'] = {
    ...profiles['ʃ'], title:'齿龈后方留窄缝，边摩擦边发声', pairedSymbol:'ʃ',
    summary:'舌前部靠近齿龈后方，双唇可略收拢。留着窄缝持续摩擦，同时轻轻发声，不先堵住气流。',
    voicing:'浊音 · 声带振动',
    contrast:'切换 /ʃ–ʒ/，听 she 的开头和 vision 中间的音。/ʒ/ 可以持续摩擦；和 /dʒ/ 比，它没有先闭塞的步骤。',
    note:commonNote + ' 两个例词的目标音位置不同，练习时只留意目标辅音。不要把 /ʒ/ 读成 /dʒ/，也不要额外加元音。自然语流中的振动程度会变化。',
    frames:[frame('zh','齿龈后摩擦 · 声带振动','ʒ：舌前部靠近齿龈后方但不完全接触，窄缝持续摩擦，同时发声；声带未画出。')]
  };
  profiles['dʒ'] = {
    ...profiles['tʃ'], title:'先闭塞，再带着摩擦连贯放开', pairedSymbol:'tʃ', sequenceLabel:'先闭塞 → 再摩擦释放',
    summary:'舌前部先贴住齿龈后方，短暂挡住气流，再打开窄缝摩擦释放。两步连成一个浊塞擦音，中间不加元音。',
    voicing:'浊音 · 振动时机随语境变化',
    contrast:'切换 /tʃ–dʒ/，比较 cheese 和 jump 的开头。两者都先闭塞再摩擦释放，注意清浊和进入后面元音的差别。',
    note:commonNote + ' /dʒ/ 是一个塞擦音，不把 d 和 ʒ 拆成两个音节。自然语流中不要求闭塞全程持续振动，也不要强行挤喉维持声音。',
    frames:[frame('j-closure','① 短暂闭塞','dʒ 起点：舌前部接触齿龈后方，口腔暂时闭塞，鼻腔通路关闭；没有口外呼气。'),frame('j-release','② 摩擦释放','dʒ 释放：舌前部打开窄缝，气流带着摩擦释放，与闭塞连成一个音；振动时机随语境变化。')]
  };
  for (const [unvoiced,voiced] of [['s','z'],['ʃ','ʒ'],['tʃ','dʒ']]) {
    profiles[unvoiced].pairedSymbol = voiced;
  }
  profiles.s.contrast += ' 再切换 /z/，比较 sip 和 zoo 的开头，留意清浊差别。';
  profiles['ʃ'].contrast += ' 再切换 /ʒ/，比较 she 开头和 vision 中间的摩擦音。';
  profiles['tʃ'].contrast += ' 再切换 /dʒ/，比较 cheese 和 jump 的开头。';
  profiles.m = {
    title:'双唇轻合，气从鼻子走',mode:'single',
    summary:'双唇轻轻合上，软腭降低，边发声边让气流从鼻腔通过。舌头不必顶住上腭。',
    voicing:'声带振动',lipHint:'双唇接触但不用使劲抿紧，不用上牙咬下唇。',
    airflow:'口腔出口被双唇封住，鼻腔通路打开。蓝色虚线表示从咽部进入鼻腔的简化路线，没有口外呼气箭头。',
    contrast:'听 moon 的开头，再听 name 的开头、sing 的结尾：/m n ŋ/ 都走鼻腔，闭塞部位分别在双唇、舌前部、舌后部。',
    note:commonNote+' 鼻腔只画简化通路；单独练习 /m/ 时不要在后面加“呃”。三个例词用于找目标音，不是最小对立词。',
    frames:[frame('m','双唇闭合 · 鼻腔通气','m：双唇闭合、软腭降低，气从鼻腔流出；舌头不封住上腭，声带振动但未画出。')],sources:[references.dental,references.ipa]
  };
  profiles.j = {
    title:'舌前部靠近硬腭，顺势滑向元音',mode:'single',
    summary:'舌前部抬高靠近硬腭，保留通道，边发声边迅速滑向后面的元音。以 yes 开头的音为例，不要停成一个独立的“衣”音节。',
    voicing:'声带振动',lipHint:'双唇自然，随后跟着元音改变；不要求用力咧嘴。',
    airflow:'舌面与硬腭之间收窄但不封闭，气流平顺通过，不制造 /ʒ/ 那样的摩擦。蓝箭头只表示口外呼气方向。',
    contrast:'听 yes 的 /j/，再听 jump 的 /dʒ/。音标 /j/ 不是字母 j 的名称，也不是 jump 开头的塞擦音。',
    note:commonNote+' 图中只展示起始姿势；实际舌位和滑动会随后面的元音改变，不要一直保持图中口型。',
    frames:[frame('palatal-j','起始姿势 · 随后滑向元音','j：舌前部抬高靠近硬腭但留有通道，随后顺势滑向元音；单图不是完整动作序列。')],sources:[references.dental,references.ipa]
  };
  profiles.h = {
    title:'顺着后面元音的口型，轻轻呼气',mode:'single',
    summary:'准备好后面元音的口型，轻轻呼气后进入元音。舌头不用顶住上腭，也不用使劲摩擦喉咙。',
    voicing:'通常声带不振动',lipHint:'口型随后面的元音变化；hand 和 he 的嘴形可以不同。',
    airflow:'气流通过声门进入开放的口腔。图中蓝箭头只示向口外呼气，声门和声带没有画出，不把口腔标成摩擦部位。',
    contrast:'听 hand 的开头，直接从轻轻呼气进入后面的元音，不额外加一个汉语“喝”的音节。',
    note:commonNote+' /h/ 的口腔形状受相邻元音影响，没有一套固定舌形；图示只表示开放通道。自然语流中的发声状态可能变化。',
    frames:[frame('h','轻轻呼气 · 口型随元音变化','h：口腔通道开放，舌头不形成闭塞；声门在喉部，本图未画出，舌位只是示意。')],sources:[references.dental,references.ipa]
  };
  profiles['ɑː'] = {
    title:'舌位放低，双唇不拢圆',mode:'single',
    summary:'嘴自然张开，舌位较低、偏后，双唇不拢圆。不要用力把舌根向后挤。',
    voicing:'声带振动',lipHint:'下颌自然放低，双唇放松、不收成圆孔。',
    airflow:'舌面不碰上腭，口腔保持开放；蓝箭头只示呼气方向。',
    contrast:'听 father 的元音，再听 cup 的元音，比较低舌位与较中央的音色，不只比较长短。',
    note:commonNote+' 英美真实舌位随口音变化；本页把美音来源 /ɑ/ 显示为 /ɑː/，不要求把美音刻意拉长。',
    frames:[frame('palm','低舌位 · 不圆唇','ɑː 参考：舌位较低偏后，双唇不圆，口腔通道开放。')],sources:[references.vowels,references.british]
  };
  profiles['ʌ'] = {
    title:'舌位在中央附近，嘴唇自然放松',mode:'single',
    summary:'舌位在口腔中央附近、中间偏低，双唇不圆。和 /ɑː/ 比，图示舌位较高、较靠前。',
    voicing:'声带振动',lipHint:'嘴自然张开，双唇不拢圆，也不用刻意向两边拉。',
    airflow:'口腔通道开放，气流平顺通过，没有闭塞或摩擦。',
    contrast:'听 cup、run 的重读元音，再与 father 比较音色。不要只把 /ɑː/ 缩短来代替 /ʌ/。',
    note:commonNote+' /ʌ/ 的实际位置随口音变化，常用中央附近的音实现；图示不要求照字形把舌头使劲后缩。',
    frames:[frame('strut','中央附近 · 不圆唇','ʌ 参考：舌位在中央附近，比本组 ɑː 图较高，双唇不圆。')],sources:[references.vowels,references.british]
  };
  profiles['ɔː'] = {
    title:'舌后部抬高一些，双唇拢圆',mode:'single',
    summary:'与本组 /ɒ/ 图相比，舌后部抬高一些，嘴的开口收小，双唇圆一些。保持顺畅发声。',
    voicing:'声带振动',lipHint:'自然拢圆，不要用力噘嘴；程度随口音变化。',
    airflow:'口腔通道收窄但没有堵住，气流平顺通过。蓝箭头不表示舌头运动。',
    contrast:'先听英音 saw 和 sock，比较元音的音色与圆唇程度；不要只把 sock 的元音拉长。',
    note:commonNote+' 现代英音的舌位可以比传统示意更高。部分美国口音把 /ɔ/ 与 /ɑ/ 合并；本页示范保留区别，不代表所有美音。',
    frames:[frame('thought','后部较高 · 圆唇','ɔː 参考：舌后部比本组 ɒ 图更高，双唇拢圆，通道仍开放。')],sources:[references.vowels,references.british]
  };
  profiles['ɒ'] = {
    title:'舌位放低，嘴唇略拢圆',mode:'single',
    summary:'嘴张开，舌位较低、偏后，双唇略拢圆。和本组 /ɑː/ 示意相比，留意嘴唇的不同。',
    voicing:'声带振动',lipHint:'嘴张开但唇缘略圆，不要强行收成很小的孔。',
    airflow:'气流从开放的口腔通过，舌面不接触上腭。',
    contrast:'听英音 sock，再听 saw：比较舌位高低与音色。切到美音时，sock 对应 /ɑː/，图也会换成不圆唇参考。',
    note:commonNote+' 这里展示英音 LOT 元音的一种较低舌位参考；现代英音常有更高的实现，不要求按图强压低舌头。sock 的英音 /ɒ/ 与美音 /ɑː/ 是口音对应，不是同一符号的别名。',
    frames:[frame('lot','低后舌位 · 略圆唇','英音 ɒ 参考：舌位较低偏后、双唇略圆，口腔通道开放。')],sources:[references.vowels,references.british]
  };
  profiles['ɜː'] = {
    title:'中央元音，保持自然发声',mode:'single',
    summary:'舌位在中央附近，双唇放松、不拢圆。听 bird 的英音，元音保持连贯，不加 r 音色。',
    voicing:'声带振动',lipHint:'自然微张，不用刻意咧嘴或噘嘴。',
    airflow:'口腔通道开放，舌头不接触上腭；蓝箭头只示呼气方向。',
    contrast:'对比 bird 的英美元音：本页英音 /ɜː/ 不带 r 音色，美音 /ɜːr/ 带 r 音色。再听 about 开头的弱读 /ə/。',
    note:commonNote+' /ɜː/ 与 /ə/ 可有相近的中央舌位，但重音、时长和具体音色受语境影响；不能简单把所有 /ə/ 拉长当成 /ɜː/。',
    frames:[frame('nurse-central','英音 · 中央元音','ɜː：中央舌位参考，双唇不圆，口腔气道开放；bird 英音不加 r 音色。')],sources:[references.vowels,references.british]
  };
  profiles['ə'] = {
    title:'嘴和舌头放松，轻轻带过',mode:'single',
    summary:'听 about 第一个音节：轻轻、自然地带过，重音落在后面。舌位在中央附近，不用把每个音节都念得一样响。',
    voicing:'通常声带振动',lipHint:'双唇自然放松，不刻意拢圆。',
    airflow:'口腔通道开放，气流平顺通过，不需要舌头闭塞或制造摩擦。',
    contrast:'听 about 开头和 teacher 英音结尾的弱读元音。about 的美音 /ə/ 也不带 r 音色，不是所有美音弱读都变成 /ər/。',
    note:commonNote+' 图只表示中央附近的一种参考；/ə/ 舌位受相邻音影响，不要求固定口型。弱读不是故意耳语或完全不发声。',
    frames:[frame('schwa','弱读 · 中央舌位参考','ə：嘴唇放松、舌位在中央附近，非重读音节轻轻带过；实际舌位随语境变化。')],sources:[references.vowels,references.british]
  };
  for(const [symbol,weak] of [['ɜːr',false],['ər',true]]) {
    profiles[symbol] = {
      title:weak?'轻轻发出带 r 音色的词尾':'连贯发出带 r 音色的重读元音',mode:'single',
      summary:weak?'听 teacher 的美音词尾：轻、弱地带着 r 音色，不要把末尾念得和重读音节一样突出。':'听 bird 的美音：元音带着 r 音色，连贯发出，不拆成“呃”和 r 两段。',
      voicing:'声带振动',lipHint:'双唇自然或略收拢，不用用力噘嘴。',
      airflow:'图示用舌身隆起的一种方式，舌根附近也收窄但保持通气。舌头中央不顶住上腭；舌侧接触在侧面图中省略。',
      contrast:weak?'比较 teacher 的英音词尾 /ə/ 和美音词尾 /ər/。两者都弱读，美音有 r 音色；不要额外增加音节。':'比较 bird 的英音 /ɜː/ 和美音 /ɜːr/。同一个词切换口音，听 r 音色的变化。',
      note:commonNote+' 这是可选舌形之一，也有人采用舌尖抬起的方式，不要求强行卷舌。'+(weak?' /ər/ 也写作 /ɚ/，不是长元音；与重读 r 色彩元音可以共享相近舌形，但发音力度和时长随语境变化。':' /ɜːr/ 在来源中写作 /ɝ/；本页写法不要求将元音和 r 分开读或刻意拉长。'),
      frames:[frame('rhotic-vowel',weak?'美音弱读 · r 音色':'美音重读 · r 音色','带 r 音色元音：一种舌身隆起、舌尖低位的方式；通道保持开放。单图不是元音与 r 的两步动作。')],sources:[references.rhotic,references.vowels]
    };
  }
  for (const [ukSymbol,usSymbol,word,start,position,variation] of [
    ['ɪə','ɪr','ear','near-start','舌前部较高，双唇不圆','现代英音也可能用较稳定的长元音实现，不必刻意做很大的滑动。'],
    ['eə','er','hair','square-start','舌前部在中间偏低位置，双唇不圆','许多现代英音用较稳定的 /ɛː/ 类音色，不要求听到明显的两个阶段。'],
    ['ʊə','ʊr','pure','cure-start','舌位较高、稍偏后，双唇轻轻拢圆','这组变化较多，一些英音会采用 /ɔː/ 类读法；pure 的实际读法和滑动幅度随口音而变。']
  ]) {
    for (const accent of ['uk','us']) {
      const british=accent==='uk', symbol=british?ukSymbol:usSymbol;
      profiles[symbol]={
        title:british?'从起始元音连贯滑向中央':'从起始元音连贯带上 r 音色',mode:'sequence',
        sequenceLabel:british?'起点 → 滑向中央':'起点 → r 音色',
        summary:position+'。'+(british?'随后向放松的中央舌位过渡，整个声音连在一起，不停气、不另加音节。':'连贯带上 r 音色；图示舌身隆起是一种方法，不必强行卷舌，也不要拆成两个音节。'),
        voicing:'声带振动',lipHint:ukSymbol==='ʊə'?'起点轻圆唇，随后自然调整；不要绷紧或突然换嘴形。':'双唇自然；美音带 r 音色时可以略收拢，不必用力噘嘴。',
        airflow:british?'全程保持口腔通气，舌面不封住上腭。两张图是连续变化的参考，不是闭塞与释放。':'口腔保持通气，r 色彩阶段舌头中央不顶上腭，舌根附近也参与收窄；侧面图省略舌侧接触。',
        contrast:'用 '+word+' 的英美真人录音比较 /'+ukSymbol+'～'+usSymbol+'/。'+(word==='pure'?'pure 还含其他音，整词不等于独立 /ʊr/ 示范。':''),
        note:commonNote+' 两帧只帮助观察变化，轮播不与录音同步，也不表示必须达到两个固定舌位。'+(british?variation:'起始元音与 r 音色在自然语流中相互影响，第二帧只是可选舌形参考，不能用两个孤立音拼接。')+(symbol==='ʊr'?' 独立示范采用 Julie Cunningham 的 /ʊɹ/ 真人录音；页面写作 /ʊr/。不同讲者的起始音色可能不同。':''),
        frames:[frame(start,'① 起点参考',position+'；与下一帧连成一段声音，不要求先保持一个独立元音。'),frame(british?'centering-end':'r-color-end',british?'② 滑向中央':'② 带上 r 音色',british?'舌位向中央附近过渡，通气不断；只是滑动方向参考，不是固定的独立 ə 终点。':'舌身隆起、舌根附近收窄的一种 r 色彩参考，舌头中央不碰上腭，保持连贯。')],
        sources:[references.diphthongs,references.british,references.rhotic,...(symbol==='ʊr'?[{title:'独立 /ʊɹ/ 录音：Julie Cunningham（约 0:24）',url:'https://sandiegovoiceandaccent.com/american-english-vowels/how-to-pronounce-the-oor-%CA%8A%C9%B9-vowel'}]:[])]
      };
    }
  }
  function ash(accent) {
    const british = accent === 'uk';
    return {
      title:british ? '/æ/ · 部分现代英音的示例' : '/æ/ · 美音的一种示例',mode:'single',
      summary:british ? '嘴张开，舌前部放低，气流畅通。部分现代英音的这个元音更接近较开的 a 音色。' : '嘴张开，舌前部放低。与图中的现代英音例子相比，舌位略高一些。',
      voicing:'声带振动',lipHint:'双唇放松、不拢圆；根据示范调整开口程度。',
      note:commonNote + ' 英美对比仅为示例，不是固定舌位差；尤其不能据此认定当前两段录音的舌位正好如此。',
      frames:[frame(british?'ae-uk':'ae-us',british?'英音参考 · 较开的口型':'美音参考 · 低前舌位',british?'侧面示意：舌头较低、嘴张得较开，双唇不圆。':'侧面示意：舌前部较低，但比英音参考图稍高，双唇不圆。')],
      sources:[references.british,references.ipa]
    };
  }
  function goat(accent) {
    const british = accent === 'uk';
    return {
      title:british ? '/əʊ/ · 从中央舌位滑向拢圆' : '/oʊ/ · 从偏后圆唇滑向更高', mode:'sequence',
      summary:british ? '舌位先在口腔中央附近，双唇自然，然后舌位抬高一些，嘴唇逐渐拢圆，声音连贯。' : '示例从偏后的中高舌位、较圆的双唇开始，然后舌位再抬高一些，口型收小，声音连贯。',
      voicing:'声带振动', lipHint:british ? '起点双唇较自然，随后渐渐拢圆。' : '示例的起点已较圆，随后口型稍收小；程度随说话人变化。',
      airflow:'整个元音持续经口腔通气，舌面不堵住上腭。蓝箭头指呼气方向，紫色指舌位变化。',
      contrast:'对照 nose、go 的英美真人读法，留意起始音色及过渡；不要只把它听成“长一点的 o”。',
      note:commonNote + ' 英美图是常见参考趋势，不是两个固定舌形；不少口音起点和滑动幅度不同。共享第二帧只代表滑向较高、圆唇的方向，不主张英美结尾完全相同。',
      frames:[frame(british?'goat-uk-start':'goat-us-start',british?'① 英音参考 · 中央起点':'① 美音参考 · 偏后圆唇起点',british?'əʊ 参考起点：舌位在中央、中间高度，双唇自然，口腔通道开放。':'oʊ 参考起点：舌位偏后、中高，双唇较圆，舌面不堵塞气道。'),frame('goat-end','② 滑向 · 较高舌位、双唇拢圆','参考滑向：舌位略抬高，口型收小并拢圆，连续发声；不要求达到完整独立的 ʊ。')],sources:[references.diphthongs,references.british]
    };
  }
  window.getArticulation = (card, accent) => {
    if (accent !== 'uk' && accent !== 'us') return null;
    const symbol = card?.variants?.[accent]?.symbol;
    if (!symbol) return null;
    const profile = symbol === 'æ' ? ash(accent) : ['əʊ','oʊ'].includes(symbol) ? goat(accent) : profiles[symbol];
    if (!profile) return null;
    let airflow = profile.airflow;
    if (!airflow) {
      airflow = ['θ','ð'].includes(symbol)
        ? '气流在舌尖与门牙附近的窄缝形成摩擦。橙色标记指位置；嘴外蓝箭头仅表示呼气方向。'
        : symbol === 'r'
          ? '所示 r 的舌尖或舌身中央不碰上腭；通道收窄但未封闭，气流平顺通过。外箭头不表示内部路线。'
          : '气流从口腔通畅流出，没有完全堵塞或齿唇摩擦。嘴外蓝箭头仅表示呼气方向，不是内部流线。';
    }
    const contrast = profile.contrast || ({
      'iː':'对照 /ɪ/：sheep–ship，留意音色和舌位，不只比较长短。',
      'ɪ':'对照 /iː/：ship–sheep，舌位更放松，音色也不同。',
      'θ':'对照 /ð/：think 和 this 的开头，主要留意声带振动的区别。',
      'ð':'对照 /θ/：this 和 think 的开头，舌尖位置相近，声音不同。',
      'æ':'对照 bed–bad，比较 /e–æ/ 的音色、舌位与开口程度。',
      r:'对照 /l/：right–light。这里的 r 保留中央通道，l 舌尖接触齿龈、气流从舌边走。'
    })[symbol] || '';
    const exampleWords = ({
      'ɪə':['ear'], 'ɪr':['ear'], 'eə':['hair'], 'er':['hair'], 'ʊə':['pure'], 'ʊr':['pure'],
      'ɜː':['bird','about'], 'ɜːr':['bird','teacher'], 'ə':['about','teacher'], 'ər':['teacher','bird'],
      'ɑː':['father','cup'], 'ʌ':['cup','run','father'], 'ɔː':['saw','sock'], 'ɒ':['sock','saw'],
      m:['moon','name','sing'], j:['yes','jump'], h:['hand'],
      p:['pin','bin','spin'], b:['pin','bin','spin'], t:['ten','den'], d:['ten','den'], k:['coat','goat'], 'ɡ':['coat','goat'],
      'eɪ':['day','say'], 'əʊ':['nose','go'], 'oʊ':['nose','go'], 'aʊ':['mouth','cow'], 'ɔɪ':['boy','toy'],
      f:['fan','van'], v:['fan','van','vest','west'], w:['vest','west','vine','wine'],
      l:['light','right'], r:['right','light'], 'ʊ':['full','fool','pull','pool'], 'uː':['full','fool','pull','pool'],
      'iː':['sheep','ship'], 'ɪ':['ship','sheep'], 'θ':['think','this'], 'ð':['this','think'],
      e:['bed','bad'], 'æ':['bed','bad'], n:['sin','sing'], 'ŋ':['sin','sing'],
      s:['sip','zoo','ship'], z:['sip','zoo'], 'ʃ':['she','vision','sip','ship','chip'], 'ʒ':['she','vision'], 'tʃ':['cheese','jump','ship','chip'], 'dʒ':['cheese','jump']
    })[symbol] || [];
    if (card.id === 'card-weak-r') {
      return {...profile, ...(accent === 'uk' ? {title:'teacher 英音词尾：轻轻带过', summary:'teacher 的重音在第一个音节，英音词尾 /ə/ 轻轻带过，单独读这个词时不加 r 音色。', contrast:'同一个 teacher 切换英美：英音词尾 /ə/，美音词尾 /ər/。两者都弱读；英音在后接元音的连贯语流中可能出现连接 r。'} : {}), airflow, exampleWords:['teacher','bird','about'], sources:[anatomyReference,...profile.sources]};
    }
    if (card?.variants?.uk?.symbol === 'ɒ' && accent === 'us') {
      return {...profile, airflow, contrast:'听 sock 的美音 /ɑː/，再切换英音 /ɒ/，比较不圆唇与略圆唇的参考。图示只解释口音对应，不代表录音者的精确舌形。', exampleWords:['sock','saw'], sources:[anatomyReference,...profile.sources]};
    }
    return {...profile, airflow, contrast, exampleWords, sources:[anatomyReference, ...profile.sources]};
  };
})();
