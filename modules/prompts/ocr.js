/**
 * Prompt ID: ocr.extractText
 * 對應功能：OCR → 從圖片擷取原始文字
 * 呼叫位置：modules/api.js → ocrExtractTextFromImage()
 * AI taskType：imageOCR
 * 輸出格式：純文字
 * 語言策略：保留來源語言，不跟隨介面
 */
export const extractTextPrompt = {
    id: 'ocr.extractText',
    version: '1.0.0',
    languagePolicy: 'preserve-source',
    template: `Extract all main text from the image as plain text.
Preserve the original language, character form, line breaks and punctuation. Do not translate, rewrite or convert Simplified and Traditional Chinese.
If the image is a screenshot, ignore UI buttons and visual noise and return only the main content.
Additional user instructions:
\${userInstructions}`
};

/**
 * Prompt ID: ocr.handwritingGradingJson
 * 對應功能：OCR／默寫 → 視覺模型批改手寫內容
 * 呼叫位置：modules/api.js → aiGradeHandwriting()
 * AI taskType：imageOCR
 * 輸出格式：JSON object
 * 語言策略：跟隨介面語言
 */
export const handwritingGradingJsonPrompt = {
    id: 'ocr.handwritingGradingJson',
    version: '1.0.0',
    languagePolicy: 'follow-interface',
    template: `Extract and grade the student's handwritten English words or phrases from the image.
Ignore text crossed out by hand. Preserve line order and original capitalization. If a line includes a Chinese meaning, extract it without converting its character form.
Use the supplied standard vocabulary list as the only answer source. Check English spelling and any written Chinese meaning. Report only incorrect parts and suggested corrections.
Return only strict JSON:
{
  "items": [
    {"line":"original line","english":"extracted English","chinese":"extracted Chinese or empty","correct":true,"errors":[{"type":"english|chinese","expected":"...","got":"...","suggestion":"..."}]}
  ],
  "summary":{"total":0,"correct":0,"wrong":0}
}
Additional user instructions:
\${userInstructions}`
};
