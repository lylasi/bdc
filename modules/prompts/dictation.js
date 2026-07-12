/**
 * Prompt ID: dictation.handwritingGradingMarkdown
 * 對應功能：默寫模式 → AI 手寫批改 Markdown 報告
 * 呼叫位置：features/dictation/dictation-grader.js、modules/api.js → aiGradeHandwriting()
 * AI taskType：imageOCR
 * 輸出格式：Markdown
 * 語言策略：跟隨介面語言
 */
export const handwritingGradingMarkdownPrompt = {
    id: 'dictation.handwritingGradingMarkdown',
    version: '1.0.0',
    languagePolicy: 'follow-interface',
    template: `Extract and grade the student's handwritten English words or phrases from one or more images.
Ignore text crossed out by hand. Preserve line order and original capitalization. If a line includes a Chinese meaning, extract it without converting its character form.
The dictation order may differ from the standard list. Match each written line against the supplied standard vocabulary list without relying on order. Check English spelling and any written Chinese meaning.
Return Markdown only:
1. The first line must summarize the number correct, total and wrong.
2. Then output a Markdown table with two columns: written content and result.
3. Clearly mark each result as correct or incorrect in the target Chinese language. For an incorrect result, identify the English or Chinese error and provide a correction.
4. Do not add a code fence or unrelated explanation.`
};
