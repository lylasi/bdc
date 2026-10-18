import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
async function newPage(path = '/review') {
    const context = await browser.newContext();
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== 'http://bdc-review.test') return route.abort();
        const p = url.pathname;
        if (p === '/review') return route.fulfill({ contentType: 'text/html', body: '<html><body><div id="host"></div></body></html>' });
        if (p === '/ai-config.js') return route.fulfill({ contentType: 'text/javascript', body: await readFile(root + '/ai-config.example.js', 'utf8') });
        if (!/^\/(modules|locales|features)\/[a-zA-Z0-9_./-]+\.js$/.test(p) && p !== '/tests/ai-provider-e2e.html') return route.abort();
        if (p.includes('..')) return route.abort();
        try { return route.fulfill({contentType:p.endsWith('.html')?'text/html':'text/javascript',body:await readFile(root+p,'utf8')}); } catch { return route.abort(); }
    });
    const page = await context.newPage();
    await page.goto('http://bdc-review.test' + path);
    return page;
}
try {
 const page=await newPage();
 console.log('migration',JSON.stringify(await page.evaluate(async()=>{
  localStorage.setItem('pen_global_settings',JSON.stringify({ai:{providers:{mine:{baseUrl:'https://provider.mock/v1',apiUrl:'https://provider.mock/v1/chat/completions',allowedModels:['m1']}},models:{assistant:'mine:m1'},tasks:{qaChecking:'mine:m1'}}}));
  localStorage.setItem('pen_global_secrets',JSON.stringify({aiProviders:{mine:{apiKey:'mock-key'}}}));
  const profile=await import('/modules/ai-profile-storage.js');
  profile.migrateLegacyAISettings();
  const p=profile.loadAIProfile();
  return {providers:Object.keys(p.providers),taskModels:p.taskModels,oldTasks:JSON.parse(localStorage.getItem('pen_global_settings')).ai.tasks||null};
 })));
 await page.context().close();
 const admin=await newPage();
 await admin.evaluate(async()=>{
  globalThis.__BDC_SYNC_ENDPOINT__='https://worker.mock';
  const original=fetch;
  const binding={formatVersion:1,format:'openai-chat',baseUrl:'https://provider.mock/v1',apiUrl:'https://provider.mock/v1/chat/completions',modelsUrl:'https://provider.mock/v1/models',authMode:'bearer'};
  window.fetch=async(input,init={})=>{
   const u=new URL(input);
   const json=data=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
   if(u.hostname==='provider.mock')return json({data:[{id:'allowed-model'},{id:'expensive-new-model'}]});
   if(u.hostname!=='worker.mock')return original(input,init);
   if(u.pathname==='/me')return json({user_id:'admin',role:'admin'});
   if(u.pathname==='/admin/ai-catalog')return json({version:1,config:{providers:[{id:'managed-test',name:'Test',enabled:true,...binding,models:[{id:'allowed-model'}]}],tasks:{}},credentials:{'managed-test':{hasKey:true}}});
   if(u.pathname==='/admin/ai-catalog/publish'){window.__published=JSON.parse(init.body);return json({version:2});}
   return json({version:1,providers:[],tasks:{}});
  };
  const {auth}=await import('/modules/sync-cloudflare.js');await auth.signInWithToken('mock-admin');
  const mod=await import('/features/ai-admin/ai-admin.js');mod.initAiAdmin();mod.openAiAdminPanel();
 });
 await admin.locator('[data-admin-models]').waitFor();
 const before=await admin.locator('[data-admin-models]').inputValue();
 await admin.locator('[data-admin-keyaction]').selectOption('replace');
 await admin.locator('[data-admin-key]').fill('mock-key');
 await admin.locator('[data-admin-discover]').click();
 await admin.waitForFunction(()=>document.querySelector('[data-admin-models]').value.includes('expensive-new-model'));
 const after=await admin.locator('[data-admin-models]').inputValue();
 await admin.locator('[data-admin-publish]').click();
 await admin.waitForFunction(()=>window.__published);
 const published=await admin.evaluate(()=>window.__published.config.providers[0].models.map(m=>m.id));
 console.log('admin_whitelist',JSON.stringify({before,after,published}));
} finally {await browser.close();}
