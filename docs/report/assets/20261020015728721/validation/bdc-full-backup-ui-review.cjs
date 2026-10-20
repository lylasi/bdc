const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('/Users/linus/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
const sample = process.argv[2];
if (!sample) throw new Error('Pass the exported full-backup-sample.json path');
const backup = JSON.parse(fs.readFileSync(sample, 'utf8'));
assert.equal(backup.payload.articleDocuments.length, 1, 'full backup must contain the seeded article, not only its reading records');
assert.equal(backup.payload.articleDocuments[0].id, 'art_reading_preview');
const fields = {
 learningItems: ['id','articleId','contentVersion','kind','anchor','sentence','explanation','firstViewedAt','lastViewedAt','understanding','note'],
 articleDocuments: ['id','articleId','kind','title','content','sourceItemIds','sourceMessageIds','contentVersion'],
 vocabularyBooks: ['id','name','sourceType','sourceUrl','shareId'],
 vocabularyEntries: ['id','bookId','word','meaning','phonetic','examples','sources'],
 vocabularyLinks: ['id','itemId','bookId','entryId','addedAt','removedAt'],
 conversations: ['id','articleId','title'],
 messages: ['id','conversationId','role','content','createdAt','learningItemId','contentVersion','anchor'],
 articleVersions: ['id','articleId','version','body']
};
function select(list, keys) {
 return (list || []).map(item => Object.fromEntries(keys.filter(k => item[k] !== undefined).map(k => [k,item[k]]))).sort((a,b) => String(a.id).localeCompare(String(b.id)));
}
(async () => {
 const browser = await chromium.launch({headless:true, executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 try {
  const context = await browser.newContext({viewport:{width:1440,height:960}});
  await context.route('**/*', route => {
   const u = new URL(route.request().url());
   if (u.pathname.endsWith('/ai-config.js')) return route.fulfill({contentType:'application/javascript',body:'export const SYNC={endpoint:""}; export const TTS_CONFIG={},AI_LIMITS={},OCR_CONFIG={},ARTICLE_IMPORT={},SUPABASE={};'});
   if (u.origin !== 'http://127.0.0.1:8313') return route.abort();
   return route.continue();
  });
  await context.addInitScript(() => { window.__BDC_SYNC_ENDPOINT__='http://127.0.0.1:19999/independent-full-restore'; });
  const page = await context.newPage();
  const pageErrors=[];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto('http://127.0.0.1:8313/',{waitUntil:'domcontentloaded'});
  await page.waitForTimeout(1700);
  await page.evaluate(() => {
   const modal = document.getElementById('app-modal');
   if (modal && !modal.classList.contains('hidden')) modal.querySelector('.modal-close-btn')?.click();
  });
  await page.click('#app-gear-btn');
  await page.click('#gm-backup-panel');
  await page.setInputFiles('#bk-import',sample);
  await page.locator('.bi-restore').first().waitFor();
  await page.locator('.bi-restore').first().click();
  await page.waitForFunction(() => document.getElementById('app-modal').classList.contains('hidden'));
  async function read() {
   return page.evaluate(async () => {
    const r=await import('/modules/reading-store.js');
    const a=await import('/modules/article-store.js');
    return {reading:await r.exportAll(),articles:await a.exportDocuments()};
   });
  }
  function verify(actual) {
   const counts={};
   for (const [key, keys] of Object.entries(fields)) {
    assert.deepEqual(select(actual.reading[key],keys),select(backup.payload.reading[key],keys),key+' restored content/ID/reference differs');
    counts[key]=(actual.reading[key]||[]).length;
   }
   assert.deepEqual(select(actual.articles,['id','body','title','analysis','sourceType','sourceUrl']),select(backup.payload.articleDocuments,['id','body','title','analysis','sourceType','sourceUrl']),'article body/analysis differs');
   const ids={items:new Set(actual.reading.learningItems.map(x=>x.id)),messages:new Set(actual.reading.messages.map(x=>x.id)),conversations:new Set(actual.reading.conversations.map(x=>x.id)),books:new Set(actual.reading.vocabularyBooks.map(x=>x.id)),entries:new Set(actual.reading.vocabularyEntries.map(x=>x.id))};
   for(const d of actual.reading.articleDocuments){for(const id of d.sourceItemIds||[])assert(ids.items.has(id));for(const id of d.sourceMessageIds||[])assert(ids.messages.has(id));}
   for(const m of actual.reading.messages)assert(ids.conversations.has(m.conversationId));
   for(const l of actual.reading.vocabularyLinks){assert(ids.items.has(l.itemId));assert(ids.books.has(l.bookId));assert(ids.entries.has(l.entryId));}
   assert.equal(counts.messages,70);
   return counts;
  }
  const counts=verify(await read());
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForTimeout(1500);
  verify(await read());
  assert.deepEqual(pageErrors,[]);
  console.log(JSON.stringify({ok:true,sample,flow:'fresh isolated browser: import actual exported JSON in backup UI → restore → compare → reload → compare',counts,articleCount:backup.payload.articleDocuments.length,contentAndIdsAndReferencesMatch:true,persistsAfterReload:true,pageErrors},null,2));
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
