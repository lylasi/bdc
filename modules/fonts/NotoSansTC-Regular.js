// Noto Sans TC Regular in Base64 for jsPDF embedding.
// Generated locally. To reduce size later, consider font subsetting.
(function(){
  try {
    var base64 = `$(cat modules/fonts/NotoSansTC-Regular.base64.txt)`;
    window.SourceHanSansTC = window.SourceHanSansTC || {};
    window.SourceHanSansTC.base64 = base64;
    window.SourceHanSansTC.name = window.SourceHanSansTC.name || 'NotoSansTC-Regular';
    window.SourceHanSansTC.fileName = window.SourceHanSansTC.fileName || 'NotoSansTC-Regular.ttf';
    // Also expose generic hooks used by registerChineseFont
    window.fontBase64 = window.fontBase64 || base64;
    window.fontFamilyName = window.fontFamilyName || 'NotoSansTC-Regular';
    window.fontFileName = window.fontFileName || 'NotoSansTC-Regular.ttf';
    console.log('NotoSansTC-Regular font loaded (Base64).');
  } catch (e) {
    console.warn('Failed to initialize NotoSansTC-Regular Base64:', e);
  }
})();
