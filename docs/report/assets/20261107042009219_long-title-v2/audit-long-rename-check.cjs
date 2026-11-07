const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
const BASE='http://127.0.0.1:8313/';
const MOCK = `export const AI_LIMITS={default:{maxConcurrency:1,minIntervalMs:400}};
export const TTS_CONFIG={baseUrl:'',baseUrlRemote:'',baseUrlLocal:'',use:'remote',voicesUrl:'',apiKey:'',voices:{}};
export const OCR_CONFIG={DEFAULT_MODEL:''};
export const ARTICLE_IMPORT={FEED_URL:'',PROXY_URL:'',SOURCES:[]};
export const SYNC={};export const SUPABASE={};`;
const LONG='長名稱測試'.repeat(80); // 400 字
const books=[{id:'book-a',name:'短名',createdAt:'2026-01-01T00:00:00.000Z',sourceType:'legacy',words:[{id:'a1',word:'volunteer',meaning:'志愿者',sources:[]}]}];
(async()=>{
const b=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const ctx=await b.newContext({viewport:{width:1024,height:900},locale:'zh-CN'});
await ctx.route('**/*',r=>{const u=new URL(r.request().url());if(u.pathname.endsWith('/ai-config.js'))return r.fulfill({status:200,contentType:'application/javascript',body:MOCK});if(u.hostname==='127.0.0.1')return r.continue();return r.abort();});
await ctx.addInitScript(({books})=>{localStorage.clear();localStorage.setItem('vocabularyBooks',JSON.stringify(books));localStorage.setItem('activeBookId','book-a');localStorage.setItem('vocabImportPromptShown','1');localStorage.setItem('pen_global_settings',JSON.stringify({language:{interfaceLocale:'zh-CN'}}));},{books});
const p=await ctx.newPage();
await p.goto(BASE+'#v/book-a',{waitUntil:'load'});
await p.waitForTimeout(900);
await p.click('#word-panel-more-btn'); await p.waitForTimeout(150);
await p.locator('#word-panel-menu .menu-item').nth(3).click();
await p.waitForTimeout(500);
await p.fill('#modal-book-name', LONG);
await p.click('#app-modal .save-btn');
await p.waitForTimeout(1200);
const now=await p.evaluate(()=>({title:document.getElementById('current-book-name').textContent.length, stored:(JSON.parse(localStorage.getItem('vocabularyBooks'))[0]||{}).name.length, modalOpen:!document.getElementById('app-modal').classList.contains('hidden')}));
await p.goto(BASE+'#v/book-a',{waitUntil:'load'});
await p.waitForTimeout(1200);
const after=await p.evaluate(async()=>{
  const rs=await import('/modules/reading-store.js');
  const ui=rs.vocabularyBooksForUi();
  return {title:document.getElementById('current-book-name').textContent.length, uiName:(ui[0]||{}).name.length, ls:JSON.parse(localStorage.getItem('vocabularyBooks'))[0].name.length};
});
console.log(JSON.stringify({inputLen:LONG.length, afterSave:now, afterReload:after}));
await b.close();
})();
