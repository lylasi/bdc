/**
 * Prompt ID: dictionary.wordAnalysis
 * 對應功能：單字資料 → 取得音標、詞性及中文意思
 * 呼叫位置：modules/api.js → getWordAnalysis()
 * AI taskType：wordAnalysis
 * 輸出格式：JSON object
 * 語言策略：跟隨介面語言
 */
export const wordAnalysisPrompt = {
    id: 'dictionary.wordAnalysis',
    version: '1.0.0',
    languagePolicy: 'follow-interface',
    template: `Analyze the English word "\${word}".
Return only strict JSON with this schema:
{"phonetic":"IPA","pos":"part of speech","meaning":"the most common Chinese meaning"}
Do not add Markdown or any text outside the JSON object.`
};
