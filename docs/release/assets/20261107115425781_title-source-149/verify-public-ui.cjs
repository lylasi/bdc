const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('/Users/linus/.local/share/fnm/node-versions/v24.20.0/installation/lib/node_modules/@playwright/cli/node_modules/playwright');
const OUT = '/Users/linus/CODE/bdc/docs/release/assets/20261107115425781_title-source-149/public-ui';
const BASE = 'https://bdc.a4a4.qzz.io';
const TITLE = "Mike: Some volunteers help sell flags in the street. There are some other volunteers who help online. I'm one of them. Last month, I filmed a video to encourage people to donate money and posted it online. Although it took time, it was meaningful.";
const TERM = 'pneumonoultramicroscopicsilicovolcanoconiosis'.repeat(4);
const checks = [];
function check(name, ok, detail) { checks.push({name,ok:!!ok,...(detail ? {detail}: {})}); }
(async () => {
 const browser = await chromium.launch({headless:true});
 try {
  for (const locale of ['zh-CN','zh-HK']) {
   const context = await browser.newContext({viewport:{width:1024,height:900}});
   const errors = [];
   await context.addInitScript(locale => {
    localStorage.setItem('vocabImportPromptShown','1');
    localStorage.setItem('pen_global_settings',JSON.stringify({language:{interfaceLocale:locale}}));
   }, locale);
   await context.route('**/*',route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/ai-config.js') return route.fulfill({contentType:'application/javascript',body:'export const SYNC={endpoint:""},TTS_CONFIG={},AI_LIMITS={},OCR_CONFIG={},ARTICLE_IMPORT={},SUPABASE={};'});
    return url.origin === BASE ? route.continue() : route.abort();
   });
   const page = await context.newPage();
   page.setDefaultTimeout(20000);
   page.setDefaultNavigationTimeout(60000);
   page.on('pageerror',e=>errors.push(String(e)));
   const ready = page.waitForEvent('console',{predicate:m=>m.text().startsWith('应用程序已')});
   await page.goto(BASE+'/?module=vocabulary'); await ready;
   await page.evaluate(async ({title,term}) => {
    (await import('/modules/ui.js')).closeModal();
    const state = await import('/modules/state.js');
    state.setVocabularyBooks([{id:'title-review',name:title,sourceUrl:'https://example.com/volunteers',words:[
     {id:'posted',word:'posted it',meaning:'将它发布（在线平台，如社交媒体）',phonetic:'ˈpəʊstɪd ɪt',sources:[{pageTitle:'Original article',sourceUrl:'https://example.com/volunteers',sentence:'I filmed a video and posted it online.'}]},
     {id:'long-term',word:term,meaning:'Long word example',sources:[{pageTitle:'Long context',sentence:'An original sentence. '.repeat(100)}]}
    ]}]);
    const saved = await (await import('/modules/storage.js')).saveVocabularyBooks(); if (!saved.ok) throw Error(saved.error);
    (await import('/features/vocabulary/vocabulary.js')).selectVocabularyBook('title-review',{updateRoute:true});
   },{title:TITLE,term:TERM});
   for (const [label,width,height] of [['tablet',1024,900],['mobile',390,844],['narrow',320,740]]) {
    await page.setViewportSize({width,height});
    try {
     await page.waitForFunction(()=>!document.querySelector('#book-name-details-btn').hidden);
    } catch (error) {
     console.error(JSON.stringify({locale,label,state:await page.evaluate(async()=>{
      const state=await import('/modules/state.js'),name=document.querySelector('#current-book-name');
      return {active:state.activeBookId,books:state.vocabularyBooks.map(b=>({id:b.id,name:b.name})),name:name.textContent,scrollHeight:name.scrollHeight,clientHeight:name.clientHeight,width:name.clientWidth,hidden:document.querySelector('#book-name-details-btn').hidden};
     })},null,2));
     await page.screenshot({path:path.join(OUT,locale+'-'+label+'-diagnostic.png')});
     throw error;
    }
    const layout=await page.evaluate(()=>{
     const title=document.querySelector('#current-book-name'),header=title.closest('.panel-header');
     const actions=document.querySelector('.word-panel-actions'), h=header.getBoundingClientRect(),t=title.getBoundingClientRect(),a=actions.getBoundingClientRect();
     return {titleHeight:t.height,lineHeight:parseFloat(getComputedStyle(title).lineHeight),titleWidth:t.width,headerHeight:h.height,
      toolbarBelow:getComputedStyle(actions).display==='none'||a.top>=t.bottom-1,
      noOverflow:document.documentElement.scrollWidth<=innerWidth+1,
      titleText:title.textContent};
    });
    check(locale+' '+label+' title at most two lines and controls separated',layout.titleHeight<=layout.lineHeight*2+1&&layout.toolbarBelow&&layout.noOverflow,layout);
    check(locale+' '+label+' stored title displayed without rewriting',layout.titleText===TITLE);
    await page.screenshot({path:path.join(OUT,locale+'-'+label+'-heading.png'),animations:'disabled'});
    await page.locator('#book-name-details-btn').click();
    check(locale+' '+label+' full-name popup preserves original text',await page.locator('#modal-body .book-name-full').textContent()===TITLE);
    check(locale+' '+label+' full-name popup wraps inside viewport',await page.locator('#modal-body').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
    await page.screenshot({path:path.join(OUT,locale+'-'+label+'-full-name.png'),animations:'disabled'});
    await page.keyboard.press('Escape');
    check(locale+' '+label+' closing returns focus to title info',await page.locator('#book-name-details-btn').evaluate(el=>el===document.activeElement));
    if(width<720) {
     await page.locator('#word-panel-more-btn').click();
     check(locale+' '+label+' more menu starts below title',await page.locator('#word-panel-menu').evaluate(el=>el.getBoundingClientRect().top>=document.querySelector('#current-book-name').closest('.panel-header').getBoundingClientRect().bottom));
     await page.keyboard.press('Escape');
    }
   }
   if(await page.locator('.word-panel-actions').isVisible()) await page.locator('#edit-vocab-book-btn').click();
   else { await page.locator('#word-panel-more-btn').click(); await page.locator('#word-panel-menu .menu-item').nth(3).click(); }
   check(locale+' edit popup has concise title and intact name',!(await page.locator('#modal-title').textContent()).includes('Mike:') && await page.locator('#modal-book-name').inputValue()===TITLE);
   await page.keyboard.press('Escape');
   await page.locator('#word-list .word-item').last().locator('.word-sources-btn').click();
   check(locale+' long source word placed in scrollable body with concise heading',
    !(await page.locator('#modal-title').textContent()).includes(TERM)
    && await page.locator('#modal-body .word-source-term').textContent()===TERM
    && await page.locator('#modal-body').evaluate(el=>el.scrollHeight>el.clientHeight&&el.scrollWidth<=el.clientWidth+1));
   await page.screenshot({path:path.join(OUT,locale+'-long-source-word.png'),animations:'disabled'});
   await page.keyboard.press('Escape');
   await page.evaluate(async()=>{ const state=await import('/modules/state.js'); state.vocabularyBooks[0].name='Short book'; (await import('/features/vocabulary/vocabulary.js')).refreshVocabularyView(); });
   await page.waitForFunction(()=>document.querySelector('#book-name-details-btn').hidden);
   check(locale+' short title hides extra info icon',await page.locator('#current-book-name').textContent()==='Short book');
   check(locale+' no uncaught errors',errors.length===0,errors);
   await context.close();
  }
 } finally { await browser.close(); }
 const result={passed:checks.filter(c=>c.ok).length,total:checks.length,checks};
 fs.writeFileSync(path.join(OUT,'functional-checks.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify({passed:result.passed,total:result.total,failed:checks.filter(c=>!c.ok)},null,2));
 if(checks.some(c=>!c.ok))process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});

