const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
const BASE='http://127.0.0.1:8313/';
const MOCK = `export const AI_LIMITS={default:{maxConcurrency:1,minIntervalMs:400}};
export const TTS_CONFIG={baseUrl:'',baseUrlRemote:'',baseUrlLocal:'',use:'remote',voicesUrl:'',apiKey:'',voices:{}};
export const OCR_CONFIG={DEFAULT_MODEL:''};
export const ARTICLE_IMPORT={FEED_URL:'',PROXY_URL:'',SOURCES:[]};
export const SYNC={};export const SUPABASE={};`;
(async()=>{
const b=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const ctx=await b.newContext({viewport:{width:1024,height:900},locale:'zh-CN'});
const blocked=new Set(); const allowed=[];
await ctx.route('**/*',r=>{
  const u=new URL(r.request().url());
  if(u.pathname.endsWith('/ai-config.js')) return r.fulfill({status:200,contentType:'application/javascript',body:MOCK});
  if(u.hostname==='127.0.0.1'||u.hostname==='localhost'){allowed.push(u.pathname);return r.continue();}
  blocked.add(u.hostname);return r.abort();
});
await ctx.addInitScript(()=>{localStorage.clear();localStorage.setItem('vocabularyBooks',JSON.stringify([{id:'b1',name:'5A Unit 1',createdAt:'2026-01-01T00:00:00.000Z',sourceType:'legacy',words:[{id:'b1w1',word:'volunteer',meaning:'志愿者',sources:[]}]}]));localStorage.setItem('activeBookId','b1');localStorage.setItem('pen_global_settings',JSON.stringify({language:{interfaceLocale:'zh-CN'}}));});
const p=await ctx.newPage();
const errs=[];
p.on('pageerror',e=>errs.push('pageerror:'+e.message));
p.on('console',m=>{if(m.type()==='error') errs.push('console:'+m.text().slice(0,160));});
await p.goto(BASE+'#v/b1',{waitUntil:'load'});
await p.waitForTimeout(1200);
const res=await p.evaluate(()=>({
  version:{indexHas:!!document.querySelector('script[type="importmap"]')},
  resources: performance.getEntriesByType('resource').map(r=>r.name).filter(n=>/\.(js|css)(\?|$)/.test(n)).map(n=>n.replace(location.origin,'')),
  title: document.getElementById('current-book-name').textContent,
  detailsHidden: document.getElementById('book-name-details-btn').hidden,
  containerSupported: CSS.supports('container-type','inline-size'),
  generatedAt: new Date().toISOString()
}));
console.log(JSON.stringify({...res, blocked:[...blocked], errors:errs, allowedCount:allowed.length},null,1));
await b.close();
})();
