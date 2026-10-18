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
    const e2e = await newPage('/tests/ai-provider-e2e.html');
    console.log('existing_e2e', JSON.stringify(await e2e.evaluate(() => runAITests())));
    await e2e.context().close();
    const page = await newPage();
    console.log('additional_cases', JSON.stringify(await page.evaluate(async () => {
        globalThis.__BDC_SYNC_ENDPOINT__ = 'https://worker.mock';
        const realFetch = fetch;
        const calls = [];
        const json = (data, status=200) => new Response(JSON.stringify(data), {status,headers:{'Content-Type':'application/json'}});
        const binding = {formatVersion:1,format:'openai-chat',apiUrl:'https://provider.mock/v1/chat/completions',modelsUrl:'https://provider.mock/v1/models',authMode:'bearer'};
        const provider = {id:'managed-test',name:'Test',enabled:true,...binding,models:[{id:'m1'}]};
        let holdCredential = false, releaseCredential, offlineB = false;
        globalThis.fetch = async (input, init={}) => {
            const url = new URL(typeof input === 'string' ? input : input.url);
            if(url.hostname !== 'worker.mock') return realFetch(input,init);
            const token = init.headers?.Authorization?.slice(7);
            calls.push(url.pathname);
            if(url.pathname === '/me') return json({user_id:token === 'B' ? 'B' : 'A',role:'user'});
            if(url.pathname === '/ai-catalog') {
                if(offlineB && token === 'B') throw new TypeError('mock offline');
                return json({version:1,providers:[provider],tasks:{assistant:{providerId:'managed-test',model:'m1'}},expiresAt:new Date(Date.now()+3600000).toISOString()});
            }
            if(url.pathname.includes('/ai-catalog/providers/')) {
                if(holdCredential) return new Promise(resolve => {releaseCredential=resolve;});
                return json({apiKey:'mock-shared',catalogVersion:1,credentialRevision:1,binding});
            }
            if(url.pathname === '/ai-credentials') return json({items:[{providerId:'personal-test',version:1,deleted:false,binding,lastMutationId:'remote1'}]});
            if(url.pathname === '/ai-credentials/personal-test') return json({providerId:'personal-test',version:1,apiKey:'mock-personal',binding});
            return json({},404);
        };
        const {auth,getAuthSnapshot} = await import('/modules/sync-cloudflare.js');
        const catalog = await import('/modules/ai-catalog.js');
        const profile = await import('/modules/ai-profile-storage.js');
        const sync = await import('/modules/ai-credential-sync.js');
        await auth.signInWithToken('A');
        await catalog.refreshAICatalog({force:true});
        await catalog.getManagedCredential('managed-test');
        offlineB = true;
        await auth.signInWithToken('B');
        await catalog.refreshAICatalog({force:true});
        const switched = {user:getAuthSnapshot().userId,status:catalog.getCatalogState().status,usable:catalog.isManagedUsable(),oldKeyRetained:!!catalog.peekManagedCredential('managed-test')};
        const reused = await catalog.getManagedCredential('managed-test');
        switched.reusedOldKey = reused.apiKey === 'mock-shared';
        offlineB=false;
        await auth.signOut();
        await auth.signInWithToken('A');
        await catalog.refreshAICatalog({force:true});
        holdCredential=true;
        const pending = catalog.getManagedCredential('managed-test').catch(error => error.code);
        while(!releaseCredential) await new Promise(resolve=>setTimeout(resolve,0));
        await auth.signOut();
        await auth.signInWithToken('B');
        await catalog.refreshAICatalog({force:true});
        const before = getAuthSnapshot().loggedIn;
        releaseCredential(json({},401));
        const staleCode = await pending;
        const stale401={before,after:getAuthSnapshot().loggedIn,user:getAuthSnapshot().userId,code:staleCode};
        await auth.signInWithToken('B');
        profile.applyRemoteAISettings({providers:{'personal-test':{label:'Remote',enabled:true,...binding,allowedModels:['m1']}},models:{assistant:'personal-test:m1'}},new Date().toISOString());
        const beforeCount = calls.length;
        await sync.syncCredentials();
        const coldDevice={syncState:sync.getCredentialSyncState().status,credentialCount:Object.keys(profile.loadAIProfile().credentials).length,requests:calls.slice(beforeCount)};
        const previousFetch = fetch;
        let releasePut;
        globalThis.fetch = async (input, init={}) => {
            if(String(input).includes('/ai-credentials/personal-upload') && init.method === 'PUT') {
                return new Promise(resolve => {releasePut=()=>resolve(json({version:1,providerId:'personal-upload'}));});
            }
            return previousFetch(input,init);
        };
        await sync.savePersonalProvider({providerId:'personal-upload',provider:{label:'Upload',enabled:true,...binding,allowedModels:['m1']},apiKey:'mock-upload',keyChanged:true,syncMode:'cloud'});
        const syncing = sync.syncCredentials();
        while(!releasePut) await new Promise(resolve=>setTimeout(resolve,0));
        await sync.savePersonalProvider({providerId:'personal-new',provider:{label:'Added during sync',enabled:true,...binding,allowedModels:['m1']},apiKey:'mock-new',keyChanged:true,syncMode:'local-only'});
        const beforeSave = !!profile.loadAIProfile().providers['personal-new'];
        releasePut();
        await syncing;
        const concurrentSave = {before:beforeSave,after:!!profile.loadAIProfile().providers['personal-new']};
        catalog.destroyAICatalog();
        return {switched,stale401,coldDevice,concurrentSave};
    })));
    await page.context().close();
    for (const locale of ['zh-CN','zh-HK']) {
        const ui = await newPage();
        await ui.setViewportSize({width:390,height:844});
        await ui.evaluate(async locale => {
            globalThis.__BDC_SYNC_ENDPOINT__='';
            const original=fetch;
            window.fetch=async (input,init={}) => {
                if(String(input).startsWith('https://provider.mock')) return new Response(JSON.stringify({data:[{id:'model-a'},{id:'model-b'}]}),{headers:{'Content-Type':'application/json'}});
                return original(input,init);
            };
            const {setLocale}=await import('/modules/i18n.js');setLocale(locale);
            const {mountAIProviderSettings}=await import('/features/sync/ai-provider-settings.js');
            mountAIProviderSettings(document.getElementById('host'));
        },locale);
        await ui.locator('[data-ai-add]').click();
        const initialVisibleInputs=await ui.locator('input:visible').count();
        await ui.locator('[data-ai-form-url]').fill('https://provider.mock/v1');
        await ui.locator('[data-ai-form-key]').fill('mock-ui-key');
        await ui.locator('[data-ai-connect]').click();
        await ui.locator('[data-ai-form-model]').waitFor();
        const selectedBefore=await ui.locator('[data-ai-form-model]').inputValue();
        await ui.locator('[data-ai-form-save]').click();
        const validation=await ui.locator('.gs-ai-error').innerText();
        await ui.locator('[data-ai-form-model]').selectOption('model-b');
        await ui.locator('[data-ai-form-save]').click();
        const saved=await ui.evaluate(async()=>{const p=(await import('/modules/ai-profile-storage.js')).loadAIProfile();return {providers:Object.keys(p.providers).length,model:p.defaultModel.split(':').slice(1).join(':')};});
        console.log('ui_flow',JSON.stringify({locale,initialVisibleInputs,selectedBefore,validation,saved}));
        await ui.context().close();
    }
} finally { await browser.close(); }
