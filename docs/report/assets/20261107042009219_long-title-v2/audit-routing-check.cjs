const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
const BASE='http://127.0.0.1:8313/';
const MOCK = `export const AI_LIMITS={default:{maxConcurrency:1,minIntervalMs:400}};
export const TTS_CONFIG={baseUrl:'',baseUrlRemote:'',baseUrlLocal:'',use:'remote',voicesUrl:'',apiKey:'',voices:{}};
export const OCR_CONFIG={DEFAULT_MODEL:''};
export const ARTICLE_IMPORT={FEED_URL:'',PROXY_URL:'',SOURCES:[]};
export const SYNC={};export const SUPABASE={};`;
const books=[{id:'book-a',name:'BOOK A 短名',createdAt:'2026-01-01T00:00:00.000Z',sourceType:'legacy',words:[{id:'a1',word:'volunteer',meaning:'志愿者',sources:[]}]},
             {id:'book-b',name:'BOOK B 另一個名稱',createdAt:'2026-01-01T00:00:00.000Z',sourceType:'legacy',words:[{id:'b1',word:'meaningful',meaning:'有意义的',sources:[]}]}];
(async()=>{
const b=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const cases=['#v/book-b','?utm_source=x#v/book-b','?flash=1#v/book-b','?module=vocabulary#v/book-b'];
for (const suffix of cases) {
  const ctx=await b.newContext({viewport:{width:1024,height:900},locale:'zh-CN'});
  await ctx.route('**/*',r=>{const u=new URL(r.request().url());if(u.pathname.endsWith('/ai-config.js'))return r.fulfill({status:200,contentType:'application/javascript',body:MOCK});if(u.hostname==='127.0.0.1')return r.continue();return r.abort();});
  await ctx.addInitScript(({books})=>{localStorage.clear();localStorage.setItem('vocabularyBooks',JSON.stringify(books));localStorage.setItem('activeBookId','book-a');localStorage.setItem('vocabImportPromptShown','1');localStorage.setItem('pen_global_settings',JSON.stringify({language:{interfaceLocale:'zh-CN'}}));},{books});
  const p=await ctx.newPage();
  await p.goto(BASE+suffix,{waitUntil:'load'});
  await p.waitForTimeout(1500);
  const out=await p.evaluate(()=>({title:document.getElementById('current-book-name').textContent, hash:location.hash, activeId:localStorage.getItem('activeBookId'),
    warn:Array.from(document.querySelectorAll('[role="alert"],.toast,.message')).map(n=>n.textContent.trim()).filter(Boolean).join(' | ')}));
  console.log(JSON.stringify({url:suffix, ...out}));
  await ctx.close();
}
await b.close();
})();
