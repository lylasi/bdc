const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE);
const {environment,ALICE} = require('/Users/linus/CODE/bdc/tests/helpers/extension-mv3.cjs');
(async()=>{
 const env=await environment(); let context;
 try{
 context=await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(),'bdc-smoke-')),{channel:'chromium',headless:true,viewport:{width:1200,height:860},args:['--disable-extensions-except=/Users/linus/CODE/bdc/extension','--load-extension=/Users/linus/CODE/bdc/extension']});
 context.on('page',p=>{p.on('pageerror',e=>console.log('PAGE_ERROR',e.message));p.on('console',e=>console.log('CONSOLE',e.text().slice(0,300)));});
 const sw=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'); const base='chrome-extension://'+new URL(sw.url()).host;
 const p=await context.newPage(); await p.goto(base+'/lookup.html'); await p.waitForFunction(()=>!!document.getElementById('ext-account-status').textContent);
 await p.locator('#ext-settings-open').click(); await p.locator('#ext-endpoint-input').fill(env.base); await p.locator('#ext-login-mode').selectOption('token'); await p.locator('#ext-token-input').fill(ALICE); await p.locator('#ext-connect-btn').click();
 await p.waitForFunction(()=>document.getElementById('ext-account-status').textContent.includes('alice')); console.log('LOGIN_OK');
 await p.locator('#ext-settings-close').click();
 const article=await context.newPage(); await article.goto(env.base+'/test-article');
 await article.waitForSelector('bdc-page-lookup');
 const cdp=await context.newCDPSession(article); const {root}=await cdp.send('DOM.getDocument',{depth:-1,pierce:true});
 function find(n){if(n.nodeName==='BUTTON'&&n.attributes?.includes('bdc-assistant-ball'))return n;for(const x of [...(n.children||[]),...(n.shadowRoots||[])]){const r=find(x);if(r)return r;}}
 const node=find(root); if(!node) throw Error('no ball'); const {model}=await cdp.send('DOM.getBoxModel',{nodeId:node.nodeId}); const b=model.border; console.log('BALL_BOX',b); await article.bringToFront(); await article.mouse.click((b[0]+b[4])/2,(b[1]+b[5])/2);
 await article.waitForFunction(()=>true);
 let frame;for(let i=0;i<80;i++){frame=article.frames().find(f=>f.url().includes('view=assistant'));if(frame)break;await new Promise(r=>setTimeout(r,100));}
 if(!frame){console.log('FRAMES',article.frames().map(f=>f.url()));console.log('TREE',JSON.stringify(await cdp.send('DOM.getDocument',{depth:-1,pierce:true})).slice(-9000));await article.screenshot({path:'/tmp/bdc-no-frame.png'});throw Error('no assistant frame');} await frame.locator('#ext-assistant-input').waitFor({state:'visible'}); await frame.waitForFunction(()=>document.getElementById('ext-assistant-context').textContent.includes('Major tech'));
 console.log('ASSISTANT_OK',await frame.locator('#ext-assistant-context').textContent());
 await frame.locator('#ext-inline-settings').click(); await frame.locator('#ext-ai-task').selectOption('articleCleanup'); await frame.locator('#ext-settings-close').click();
 console.log('DIALOG_OK');
 await p.evaluate(async url=>chrome.storage.local.set({bdc_extension_app_url:url}),env.appBase);
 const opened=context.waitForEvent('page'); const r=await frame.evaluate(()=>chrome.runtime.sendMessage({type:'BDC_OPEN_WINDOW',view:'article',ticket:new URL(location).searchParams.get('ticket')})); console.log('OPEN',r.ok);
 const w=await opened; await w.waitForURL('**/lookup.html?windowTicket=**'); await w.locator('#ext-article-extract').click(); await w.locator('#ext-article-preview').waitFor({state:'visible',timeout:30000}); console.log('EXTRACT_OK');
 await w.locator('#ext-article-analyze').check(); await w.locator('#ext-article-save').click(); await w.locator('#ext-article-open').waitFor({state:'visible',timeout:60000}); console.log('SAVE_OK'); await article.close();
 await w.locator('#ext-article-open').click(); await w.waitForURL('**/#a/**'); console.log('ARTICLE_WINDOW_OK');
  await p.screenshot({path:'/tmp/bdc-home-smoke.png'});
 } finally{if(context)await context.close();await env.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
