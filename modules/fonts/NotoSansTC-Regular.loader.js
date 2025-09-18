// Lightweight loader to fetch Base64 of NotoSansTC-Regular at runtime.
(async function(){
  try {
    const resp = await fetch('modules/fonts/NotoSansTC-Regular.base64.txt');
    const base64 = await resp.text();
    window.SourceHanSansTC = window.SourceHanSansTC || {};
    window.SourceHanSansTC.base64 = window.SourceHanSansTC.base64 || base64;
    window.SourceHanSansTC.name = window.SourceHanSansTC.name || 'NotoSansTC-Regular';
    window.SourceHanSansTC.fileName = window.SourceHanSansTC.fileName || 'NotoSansTC-Regular.ttf';
    // Hooks for registerChineseFont
    window.fontBase64 = window.fontBase64 || base64;
    window.fontFamilyName = window.fontFamilyName || 'NotoSansTC-Regular';
    window.fontFileName = window.fontFileName || 'NotoSansTC-Regular.ttf';
    console.log('NotoSansTC-Regular Base64 loaded');
  } catch (e) {
    console.warn('Failed to load NotoSansTC-Regular Base64:', e);
  }
})();
