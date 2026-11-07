/**
 * 長標題「修正前」對照量測（只讀執行，不改任何正式檔案）。
 *
 * 作法是載入目前版本頁面後，用 addStyleTag 疊回修正前的詞書標題列宣告
 * （flex 同排、無行數限制、關閉容器查詢、隱藏詳情／更多按鈕），
 * 藉此在同一台瀏覽器、同一份資料下取得 before/after 對照數字。
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<playwright> node tests/long-title-before-sim.cjs
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
const EN = "Mike: Some volunteers help sell flags in the street. There are some other volunteers who help online. I'm one of them. Last month, I filmed a video to encourage people to donate money and posted it online. Although it took time, it was meaningful.";
const ZH = '香港中學文憑試英文科第三單元：環境保護與社區服務義工活動完整閱讀理解練習題目與答案詳解（第二部分）';
const NS = 'https://www.example.com/learning/articles/2026/11/very-long-path-without-any-break-opportunity-abcdefghijklmnopqrstuvwxyz0123456789?token=abcdef0123456789';
const SHORT = '5A Unit 1 单词本';
const OLD_CSS = `
.vocab-words-panel { container-type: normal !important; }
.vocab-words-panel .panel-header { display: flex !important; flex-wrap: wrap !important; align-items: flex-start !important; gap: var(--sp-2) !important; }
.book-title-row { display: contents !important; }
#current-book-name { display: block !important; overflow: visible !important; flex: 1 1 160px !important; min-width: 0 !important; font-size: var(--fs-lg) !important; overflow-wrap: normal !important; }
.word-panel-actions { display: flex !important; grid-column: auto !important; justify-content: flex-end !important; }
.book-name-details-btn { display: none !important; }
.word-panel-more-btn { display: none !important; }
`;
(async () => {
  const b = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  for (const width of [320, 720, 1024, 1440]) {
    const ctx = await b.newContext({ viewport: { width, height: 900 }, locale: 'zh-CN' });
    await ctx.route('**/*', r => { const h = new URL(r.request().url()).hostname; return (h==='127.0.0.1'||h==='localhost')?r.continue():r.abort(); });
    const p = await ctx.newPage();
    await p.addInitScript(({books}) => {
      if (sessionStorage.getItem('__bf')) return; sessionStorage.setItem('__bf','1');
      localStorage.clear();
      localStorage.setItem('vocabularyBooks', JSON.stringify(books));
      localStorage.setItem('activeBookId', books[0].id);
      localStorage.setItem('vocabImportPromptShown','1');
      localStorage.setItem('pen_global_settings', JSON.stringify({ language:{interfaceLocale:'zh-CN'} }));
    }, { books: [EN,ZH,NS,SHORT].map((n,i)=>({ id:'b'+i, name:n, sourceType:'legacy', createdAt:'2026-01-01T00:00:00.000Z', words:[{id:'w',word:'volunteer',meaning:'志愿者',phonetic:'x',sources:[{title:'a',text:'b'}]}] })) });
    await p.goto('http://127.0.0.1:8313/#v', { waitUntil:'domcontentloaded' });
    await p.waitForTimeout(1400);
    await p.addStyleTag({ content: OLD_CSS });
    for (let i=0;i<4;i++) {
      await p.evaluate((id)=>{ document.querySelector(`.vocab-book-item[data-book-id="${id}"]`)?.click(); }, 'b'+i);
      await p.waitForTimeout(120);
      const out = await p.evaluate(() => {
        const t=document.getElementById('current-book-name');
        const panel=document.querySelector('#vocab-words-panel');
        const header=panel.querySelector('.panel-header');
        const acts=panel.querySelector('.word-panel-actions');
        const chips=Array.from(acts.querySelectorAll('.action-chip')).filter(c=>c.getBoundingClientRect().width>0);
        const rows=new Set(chips.map(c=>Math.round(c.getBoundingClientRect().y)));
        const tr=t.getBoundingClientRect();
        const overlaps=chips.some(c=>{const r=c.getBoundingClientRect();const w=Math.min(r.right,tr.right)-Math.max(r.left,tr.left);const h=Math.min(r.bottom,tr.bottom)-Math.max(r.top,tr.top);return w>0.5&&h>0.5;});
        const lines=(()=>{const range=document.createRange();range.selectNodeContents(t);const rects=Array.from(range.getClientRects()).filter(r=>r.height>0&&r.y+r.height/2>=tr.top-1&&r.y+r.height/2<=tr.bottom+1);return new Set(rects.map(r=>Math.round(r.y))).size;})();
        return { titleW:Math.round(tr.width), titleH:Math.round(tr.height), lines, headerH:Math.round(header.getBoundingClientRect().height), chips:chips.length, chipRows:rows.size, overlap:overlaps, pageOverflow:Math.max(0,document.documentElement.scrollWidth-document.documentElement.clientWidth), panelOverflow:panel.scrollWidth-panel.clientWidth };
      });
      console.log(width, ['en','zh','nospace','short'][i], JSON.stringify(out));
    }
    await ctx.close();
  }
  await b.close();
})();
