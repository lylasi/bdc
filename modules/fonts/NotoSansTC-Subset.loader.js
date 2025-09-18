// Noto Sans TC Subset loader
(async function(){
  try {
    if (!window.fontBase64) {
      const resp = await fetch('modules/fonts/NotoSansTC-Subset.base64.txt');
      const base64 = await resp.text();
      if (base64 && base64.length > 1024) {
        window.SourceHanSansTC = window.SourceHanSansTC || {};
        window.SourceHanSansTC.base64 = base64;
        window.SourceHanSansTC.name = 'NotoSansTC-Subset';
        window.SourceHanSansTC.fileName = 'NotoSansTC-Subset.ttf';
        window.fontBase64 = base64;
        window.fontFamilyName = 'NotoSansTC-Subset';
        window.fontFileName = 'NotoSansTC-Subset.ttf';
        console.log('Loaded NotoSansTC-Subset (', Math.round(base64.length/1024), 'KB base64 )');
      }
    }
  } catch(e) {
    console.warn('load subset font failed', e);
  }
})();
