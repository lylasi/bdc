// Scratch: does an unrelated managed-catalog refresh abort an in-flight analysis?
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
const {environment,ALICE}=require('/Users/linus/CODE/bdc/tests/helpers/extension-mv3.cjs');
const ROOT='/Users/linus/CODE/bdc'; const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 execFileSync(process.execPath,['scripts/package-extension.mjs'],{cwd:ROOT});
 const env=await environment(); const profile=fs.mkdtempSync(path.join(os.tmpdir(),'bdc-cat-'));
 let ctx, para=0, aborted=0;
 try{
  ctx=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,args:['--disable-extensions-except='+ROOT+'/extension','--load-extension='+ROOT+'/extension']});
  ctx.on('requestfailed',(r)=>{ if(r.url().includes('/mock-ai/')) aborted+=1; });
  await ctx.route(env.base+'/mock-ai/**',async(route)=>{
   if(route.request().method()==='OPTIONS') return route.fulfill({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, Authorization'}});
   let body={}; try{body=route.request().postDataJSON()||{};}catch(_){}
   const prompt=(body.messages||[]).map(m=>m.content||'').join('\n');
   const headers={'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
   if(prompt.includes('Clean the supplied Markdown article')) return route.fulfill({status:200,headers,body:JSON.stringify({choices:[{finish_reason:'stop',message:{content:'# Cat article\n\n'+Array.from({length:6},(_,i)=>`Cat Para ${i}: body ${i}.`).join('\n\n')}}]})});
   if(prompt.includes('Translate the following English paragraph')){para+=1; await sleep(5000); return route.fulfill({status:200,headers,body:JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({chinese_translation:'x'})}}]})});}
   return route.fulfill({status:200,headers,body:JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{}'}}]})});
  });
  const worker=ctx.serviceWorkers()[0]||await ctx.waitForEvent('serviceworker');
  const base='chrome-extension://'+new URL(worker.url()).host;
  const popup=await ctx.newPage(); await popup.goto(base+'/lookup.html');
  await popup.waitForFunction(()=>!!document.querySelector('#ext-account-status').textContent);
  await popup.locator('#ext-settings-open').click();
  await popup.locator('#ext-endpoint-input').fill(env.base);
  await popup.locator('#ext-login-mode').selectOption('token');
  await popup.locator('#ext-token-input').fill(ALICE);
  await popup.locator('#ext-connect-btn').click();
  await popup.waitForFunction(()=>!document.querySelector('#ext-connect-btn').disabled&&document.querySelector('#ext-account-status').textContent.includes('alice'),null,{timeout:30000});
  await popup.locator('#ext-settings-close').click();
  const source=await ctx.newPage(); await source.goto(env.base+'/test-article?cat=1'); await source.bringToFront();
  const opening=ctx.waitForEvent('page');
  const opened=await popup.evaluate(()=>chrome.runtime.sendMessage({type:'BDC_OPEN_WINDOW',view:'article',autoImport:true}));
  const page=await opening;
  await page.locator('#ext-article-preview').waitFor({state:'visible',timeout:60000});
  await page.waitForFunction(()=>!document.querySelector('#ext-article-save').disabled,null,{timeout:60000});
  const before=env.db.prepare("SELECT COUNT(*) AS n FROM articles WHERE owner_user_id='alice'").get().n;
  await page.locator('#ext-article-save').click();
  await page.locator('#ext-article-cancel').waitFor({state:'visible',timeout:10000});
  await sleep(1500);
  const reqBefore=para;
  const cat=await page.evaluate(async()=>{ const m=await import('./modules/ai-catalog.js'); const before=m.getCatalogState().generation; await m.refreshAICatalog({force:true,reason:'probe'}); return {before, after:m.getCatalogState().generation, version:m.getCatalogState().version}; });
  await page.waitForFunction(()=>!document.querySelector('#ext-article-save').disabled,null,{timeout:120000});
  const state={cat, paraBeforeRefresh:reqBefore, paraTotal:para, aborted,
    notice:await page.locator('#ext-workspace-notice').textContent(),
    previewVisible:await page.locator('#ext-article-preview').isVisible(),
    articles:env.db.prepare("SELECT COUNT(*) AS n FROM articles WHERE owner_user_id='alice'").get().n-before,
    openVisible:await page.locator('#ext-article-open').isVisible()};
  fs.writeFileSync('/tmp/bdc-perf-probe/catalog-abort.json',JSON.stringify(state,null,2));
  console.log(JSON.stringify(state,null,2));
 }finally{ await ctx?.close(); await env.close(); fs.rmSync(profile,{recursive:true,force:true}); }
})().catch(e=>{console.error(e);process.exitCode=1;});
