const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path=require('path');
const ROOT=path.resolve(__dirname,'..');
const BASE=process.env.PHONETICS_BASE_URL || 'http://127.0.0.1:8876';
const fs=require('fs'); const assert=require('assert/strict');
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const errors=[];const results=[];
 try {
 for(const locale of ['zh-CN','zh-HK']) {
  const context=await browser.newContext({viewport:{width:1100,height:850}});
  const audioRequests=[];let aiCount=0;
  const config=fs.readFileSync(path.join(ROOT,'ai-config.example.js'),'utf8').replaceAll('https://tbai.xin','https://mock-ai.test').replace("export const API_KEY = '';","export const API_KEY = 'test-key';").replace("apiKey: ''","apiKey: 'test-key'").replaceAll('https://your-tts.example.com','https://mock-tts.test');
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname==='/ai-config.js') return route.fulfill({contentType:'text/javascript',body:config});
   if(url.hostname==='mock-ai.test') {
    aiCount++;const prompt=route.request().postDataJSON().messages[0].content;
    const accent=prompt.includes('required accent is us')?'us':'uk';
    const word=prompt.match(/JSON string: "([a-z -]+)"/)?.[1]||'apple';
    const readings=word==='destroy buildings'?[{ipa:'dɪˈstrɔɪ ˈbɪldɪŋz'}]:word==='unlisted'?[]:word==='read'?[{ipa:'riːd',pos:'verb',meaning:'present'},{ipa:'red',pos:'verb',meaning:'past'}]:word==='shelter'?[{ipa:'ˈʃɛltə',pos:'noun',meaning:'庇护所'}]:[{ipa:'ˈæp.əl',pos:'noun',meaning:'苹果'}];
    return route.fulfill({contentType:'application/json',body:JSON.stringify({choices:[{message:{content:JSON.stringify({word,accent,readings})}}]})});
   }
   if(url.hostname==='mock-tts.test'||url.hostname==='local-tts.test') {
    if(url.pathname==='/voices') return route.fulfill({contentType:'application/json',body:JSON.stringify([{short_name:'en-GB-AbbiNeural',locale:'en-GB',name:'Abbi'},{short_name:'en-US-JennyNeural',locale:'en-US',name:'Jenny'}])});
    audioRequests.push({host:url.hostname,word:url.searchParams.get('t'),voice:url.searchParams.get('v')});
    return route.fulfill({contentType:'audio/mpeg',body:fs.readFileSync(path.join(ROOT,'phonetic-chart/audio/words/uk/ship.mp3'))});
   }
   if(url.hostname==='127.0.0.1') return route.continue();
   return route.abort();
  });
  await context.addInitScript(({locale})=>{
   if(!localStorage.getItem('test-fixture')) {
    localStorage.setItem('test-fixture','1');
    localStorage.setItem('pen_global_settings',JSON.stringify({language:{interfaceLocale:locale},tts:{use:'remote',baseUrlRemote:'https://mock-tts.test',baseUrlLocal:'http://local-tts.test:8888',selectedVoices:{'en-GB':'en-GB-AbbiNeural','en-US':'en-US-JennyNeural'}},assistant:{enabled:false}}));
    localStorage.setItem('vocabularyBooks',JSON.stringify([{id:'fixture-book',name:'Fixture',words:[{id:'ship-id',word:'ship',phonetic:'ʃɪp',meaning:'船'},{id:'apple-id',word:'apple',meaning:'苹果'},{id:'shelter-id',word:'shelter',meaning:'庇护所'}]}]));
    localStorage.setItem('activeBookId','fixture-book');
   }
  },{locale});
  const page=await context.newPage();page.on('console',msg=>{if(msg.type()==='error')console.log('TEST console:',msg.text().slice(0,500));});page.on('pageerror',e=>errors.push(e.message));
  await page.goto(BASE+'/index.html');
  assert.equal(await page.locator('.word-phonetics-btn').count(),0);
  await page.locator('#learning-btn').click();
  await page.locator('#word-select').selectOption('ship-id');
  assert.equal(await page.locator('#phonetics-open').isVisible(),false);
  await page.locator('#app-gear-btn').click();
  await page.locator('#gm-settings').click();
  await page.locator('#gs-phonetics-enabled').check();
  await page.locator('#gs-save').click();
  await page.waitForTimeout(650);
  assert.equal(await page.locator('#phonetics-open').isVisible(),true);
  await page.locator('#vocabulary-btn').click();
  assert.equal(await page.locator('#word-list .word-phonetics-btn').count(),3);
  // 單詞本入口 → 只呈現該詞的拆音彈窗（不再內嵌查詞頁）
  await page.locator('#word-list .word-phonetics-btn').first().click();
  await page.locator('.phonetics-sheet .ps-sound').first().waitFor();
  assert.equal(await page.locator('.ps-word').innerText(),'ship');
  assert.match(await page.locator('.ps-ipa').innerText(),/ʃɪp/);
  assert.equal(await page.locator('.ps-sound').count(),3);
  assert.equal(await page.locator('.phonetics-sheet #phonetic-word').count(),0);
  assert.equal(await page.locator('#phonetics-frame').count(),0);
  await page.locator('.ps-sound').first().click();
  await page.locator('.ps-art img').first().waitFor();
  await page.locator('.ps-play').click();
  await page.waitForTimeout(300);
  assert.equal(audioRequests.at(-1).voice,'en-GB-AbbiNeural');
  assert.equal(audioRequests.at(-1).host,'mock-tts.test');
  // ship 的詞條音標與本地詞庫一致，來源標為本地（不觸發 AI）
  assert.match(await page.locator('.ps-source').innerText(),/本地|本機/);
  await page.locator('#app-modal .modal-close-btn').click();
  assert.equal(await page.locator('#app-modal').isHidden(),true);
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'/tmp/bdc-book-icon-'+locale+'.png'});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.setViewportSize({width:1100,height:850});
  // 學習模式入口 → 同一個彈窗
  await page.locator('#learning-btn').click();
  await page.locator('#phonetics-open').click();
  await page.locator('.ps-ipa').filter({hasText:'ʃɪp'}).waitFor();
  const before=aiCount;
  await page.locator('.ps-play').click();
  await page.waitForTimeout(300);
  assert.equal(audioRequests.at(-1).voice,'en-GB-AbbiNeural');
  assert.equal(audioRequests.at(-1).host,'mock-tts.test');
  assert.equal(aiCount,before);
  // 切換美音：本地詞庫有 ship 的美音，改用它且不應再打 AI 查詢
  const beforeAccent=aiCount;
  await page.locator('.ps-accent[data-accent="us"]').click();
  await page.locator('.ps-accent[data-accent="us"].is-active').waitFor();
  await page.waitForTimeout(400);
  assert.equal(aiCount,beforeAccent);
  assert.match(await page.locator('.ps-ipa').innerText(),/ʃɪp/);
  assert.match(await page.locator('.ps-source').innerText(),/本地|本機/);
  await page.locator('.ps-play').click();
  await page.waitForTimeout(300);
  assert.equal(audioRequests.at(-1).voice,'en-US-JennyNeural');
  // 逐音跟讀：美音詞庫有 ship，示範音也要有（不應出現「暫無獨立示範」）
  await page.locator('.ps-sequence').click();
  await page.waitForTimeout(2500);
  const seqStatus=await page.locator('.ps-status').innerText();
  assert.equal(/暫無獨立示範|暂无独立示范/.test(seqStatus),false);
  assert.equal(/\{symbol\}/.test(seqStatus),false);
  await page.locator('#app-modal .modal-close-btn').click();
  // 詞書沒有音標、本地詞庫也沒收錄 → 走 AI 查詢
  await page.locator('#vocabulary-btn').click();
  await page.locator('#word-list .word-phonetics-btn').nth(1).click();
  try { await page.locator('.ps-ipa').filter({hasText:'ˈæp.əl'}).waitFor({timeout:10000}); } catch(e) { console.log(JSON.stringify({aiCount,status:await page.locator('.ps-status').innerText(),errors})); throw e; }
  assert.match(await page.locator('.ps-source').innerText(),/AI/);
  assert.ok(aiCount>before);
  await page.screenshot({path:'/tmp/bdc-phonetics-'+locale+'.png'});
  await page.locator('#app-modal .modal-close-btn').click();
  // AI 回傳另一種常見寫法（/ˈʃɛltə/ 的 ɛ）：仍要對應到音標表的 /e/ 示範音，
  // 逐音跟讀不可以整段中斷，也不可以出現「暫無獨立示範」。
  await page.locator('#word-list .word-phonetics-btn').nth(2).click();
  await page.locator('.ps-ipa').filter({hasText:'ˈʃɛltə'}).waitFor({timeout:10000});
  assert.equal(await page.locator('.ps-sound.is-unavailable').count(),0);
  assert.deepEqual(await page.locator('.ps-sound').allTextContents(),['ʃ','ɛ','l','t','ə']);
  await page.locator('.ps-sequence').click();
  await page.waitForTimeout(2500);
  const notationStatus=await page.locator('.ps-status').innerText();
  assert.equal(/暫無獨立示範|暂无独立示范|已略過|已跳过/.test(notationStatus),false);
  await page.locator('#app-modal .modal-close-btn').click();
  await page.locator('#app-gear-btn').click();await page.locator('#gm-settings').click();
  await page.locator('#gs-phonetics-enabled').uncheck();
  await page.locator('label:has(#gs-tts-use-local)').click();
  await page.locator('#gs-save').click();await page.waitForTimeout(650);
  assert.equal(await page.locator('#phonetics-open').isVisible(),false);
  assert.equal(await page.locator('.word-phonetics-btn').count(),0);
  await page.goto(BASE+'/phonetics.html?word=ship&accent=uk');
  await page.locator('#phonetic-play').click();await page.waitForTimeout(200);
  assert.equal(audioRequests.at(-1).host,'local-tts.test');
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'/tmp/bdc-phonetics-mobile-'+locale+'.png'});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const beforeShelter = aiCount;
  await page.goto(BASE+'/phonetics.html?word=shelter&accent=uk&referenceIPA='+encodeURIComponent('ˈʃeltə(r)'));
  await page.locator('#phonetic-sounds button').first().waitFor();
  assert.deepEqual(await page.locator('#phonetic-sounds button').allTextContents(),['ʃ','e','l','t','ə','(r)']);
  assert.equal(aiCount,beforeShelter);
  assert.match(await page.locator('#phonetic-source').innerText(),/口音/);
  assert.equal(new URL(page.url()).searchParams.get('referenceIPA'),'ˈʃeltə(r)');
  assert.equal(new URL(page.url()).searchParams.has('ipa'),false);
  await page.reload();
  await page.locator('#phonetic-sounds button').first().waitFor();
  await page.locator('[name=accent][value=us]').check();
  assert.equal(await page.locator('#phonetic-ipa').innerText(),'/ˈʃeltə(r)/');
  await page.locator('#phonetic-form button').click();
  assert.equal(aiCount,beforeShelter);
  await page.locator('#phonetic-sounds button').first().click();
  await page.locator('#phonetic-audio-status').filter({hasText:/播放/}).waitFor();
  await page.screenshot({path:'/tmp/bdc-shelter-fixed-'+locale+'.png'});
  await page.locator('#phonetic-stop').click();
  await page.locator('#phonetic-sounds button').filter({hasText:/^t$/}).click();
  assert.equal(await page.locator('.art-preview').count(),2);
  await page.locator('.art-preview').first().click();
  assert.equal(await page.locator('#art-viewer').isVisible(),true);
  assert.equal(await page.locator('#art-count').innerText(),'1 / 2');
  await page.locator('#art-next').click();
  assert.equal(await page.locator('#art-count').innerText(),'2 / 2');
  await page.locator('#art-in').click();
  assert.equal(await page.locator('#art-reset').innerText(),'150%');
  await page.locator('#art-reset').click();
  await page.locator('#art-stage').evaluate(el => {
    el.dispatchEvent(new PointerEvent('pointerdown',{pointerId:1,clientX:80,clientY:180,bubbles:true}));
    el.dispatchEvent(new PointerEvent('pointerup',{pointerId:1,clientX:240,clientY:180,bubbles:true}));
  });
  assert.equal(await page.locator('#art-count').innerText(),'1 / 2');
  await page.screenshot({path:'/tmp/bdc-art-viewer-'+locale+'.png'});
  await page.locator('#art-close').click();
  assert.equal(await page.locator('#art-viewer').isVisible(),false);

  await page.locator('#phonetic-word').fill('unlisted');
  await page.locator('#phonetic-form button').click();
  await page.locator('#phonetic-status[data-error=true]').waitFor();
  assert.equal(await page.locator('#phonetic-play').isVisible(),true);
  assert.equal(await page.locator('#phonetic-ipa').innerText(),'');
  const beforePhrase = aiCount;
  await page.goto(BASE+'/phonetics.html?word=destroy%20buildings&accent=uk&referenceIPA='+encodeURIComponent('dɪˈstrɔɪ ˈbɪldɪŋz'));
  await page.locator('#phonetic-sounds button').first().waitFor();
  assert.equal(await page.locator('#phonetic-title').innerText(),'destroy buildings');
  assert.equal(await page.locator('.sound-word-gap').count(),1);
  assert.equal(aiCount,beforePhrase);
  await page.locator('#phonetic-play').click();await page.waitForTimeout(200);
  assert.equal(audioRequests.at(-1).word,'destroy buildings');
  await page.goto(BASE+'/phonetics.html?word=destroy%20buildings&accent=uk');
  await page.locator('#phonetic-source').filter({hasText:/AI/}).waitFor();
  assert.equal(await page.locator('#phonetic-ipa').innerText(),'/dɪˈstrɔɪ ˈbɪldɪŋz/');
  assert.equal(aiCount,beforePhrase+1);
  await page.goto(BASE+'/phonetic-chart/index.html');
  await page.locator('.phoneme-card').first().waitFor();
  results.push({locale,passed:true,aiCalls:aiCount,ttsCalls:audioRequests.length});
  await context.close();
 }
 console.log(JSON.stringify({results,errors}));
 assert.deepEqual(errors,[]);
 }finally{await browser.close();}
})().catch(e=>{console.error(e.message);process.exit(1);});
