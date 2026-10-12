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


export const pronunciationPrompt = {
    id: 'dictionary.pronunciation',
    version: '1.1.0',
    languagePolicy: 'follow-interface',
    template: `Give dictionary-style broad IPA readings for the English word or phrase in this JSON string: \${wordJSON}.
The required accent is \${accent} (uk = British English, us = American English).
Return strict JSON: {"word":"the exact input word or phrase","accent":"\${accent}","readings":[{"ipa":"IPA without slashes","pos":"part of speech","meaning":"short meaning distinguishing this reading"}]}.
For a phrase, return the IPA for the entire phrase in each reading, preserving spaces between words. Use a clear careful reading; do not return separate readings for individual words. Include distinct common readings for heteronyms (e.g. read, live, lead) separately, at most 6. Preserve stress and vowel length. Use syllable boundaries where needed. Do not guess if uncertain: return an empty readings array. Do not claim a dictionary source or include audio URLs.`
};
