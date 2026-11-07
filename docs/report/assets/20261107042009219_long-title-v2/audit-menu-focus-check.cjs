const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
const BASE='http://127.0.0.1:8313/';
const MOCK = `export const AI_LIMITS={default:{maxConcurrency:1,minIntervalMs:400}};
export const TTS_CONFIG={baseUrl:'',baseUrlRemote:'',baseUrlLocal:'',use:'remote',voicesUrl:'',apiKey:'',voices:{}};
export const OCR_CONFIG={DEFAULT_MODEL:''};
export const ARTICLE_IMPORT={FEED_URL:'',PROXY_URL:'',SOURCES:[]};
export const SYNC={};export const SUPABASE={};`;
const books=[{id:'book-a',name:'Mike: Some volunteers help sell flags in the street. There are some other volunteers who help online.',createdAt:'2026-01-01T00:00:00.000Z',sourceType:'legacy',words:[{id:'a1',word:'volunteer',meaning:'志愿者',sources:[]}]}];
(async()=>{
const b=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
for (const w of [320,719,1024,1440]) {
  const ctx=await b.newContext({viewport:{width:w,height:900},locale:'zh-CN'});
  await ctx.route('**/*',r=>{const u=new URL(r.request().url());if(u.pathname.endsWith('/ai-config.js'))return r.fulfill({status:200,contentType:'application/javascript',body:MOCK});if(u.hostname==='127.0.0.1')return r.continue();return r.abort();});
  await ctx.addInitScript(({books})=>{localStorage.clear();localStorage.setItem('vocabularyBooks',JSON.stringify(books));localStorage.setItem('activeBookId','book-a');localStorage.setItem('vocabImportPromptShown','1');localStorage.setItem('pen_global_settings',JSON.stringify({language:{interfaceLocale:'zh-CN'}}));},{books});
  const p=await ctx.newPage();
  await p.goto(BASE+'#v/book-a',{waitUntil:'load'});
  await p.waitForTimeout(900);
  const chipsVisible = await p.evaluate(()=>getComputedStyle(document.querySelector('.word-panel-actions')).display!=='none');
  const out={width:w, chipsVisible};
  // 開啟「編輯」→ 關閉 → 看焦點
  if (chipsVisible) { await p.click('#edit-vocab-book-btn'); }
  else {
    await p.click('#word-panel-more-btn');
    await p.waitForTimeout(160);
    out.focusInMenu = await p.evaluate(()=>document.activeElement?document.activeElement.className:'');
    await p.locator('#word-panel-menu .menu-item').nth(3).click();
  }
  await p.waitForTimeout(400);
  out.modalOpen = await p.evaluate(()=>!document.getElementById('app-modal').classList.contains('hidden'));
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);
  out.afterClose = await p.evaluate(()=>({tag:document.activeElement.tagName, id:document.activeElement.id, cls:document.activeElement.className}));
  // 再測「合併」彈窗（同為選單路徑）
  if (!chipsVisible) {
    await p.click('#word-panel-more-btn'); await p.waitForTimeout(160);
    await p.locator('#word-panel-menu .menu-item').nth(1).click();
    await p.waitForTimeout(500);
    out.mergeOpen = await p.evaluate(()=>!document.getElementById('app-modal').classList.contains('hidden'));
    await p.keyboard.press('Escape'); await p.waitForTimeout(300);
    out.afterMergeClose = await p.evaluate(()=>({tag:document.activeElement.tagName,id:document.activeElement.id,cls:document.activeElement.className}));
  }
  console.log(JSON.stringify(out));
  await ctx.close();
}
await b.close();
})();
