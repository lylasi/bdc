/**
 * Prompt ID: learning.exampleGeneration
 * 對應功能：學習模式 → 產生 AI 例句及詞語對齊
 * 呼叫位置：modules/api.js → generateExamplesForWord()
 * AI taskType：exampleGeneration
 * 輸出格式：JSON array
 * 語言策略：跟隨介面語言
 */
export const exampleGenerationPrompt = {
    id: 'learning.exampleGeneration',
    version: '1.0.0',
    languagePolicy: 'follow-interface',
    template: `Generate 3 natural English example sentences for the word "\${word}".
For each sentence, provide its Chinese translation and an English-to-Chinese alignment array.
Return only strict JSON using this schema:
[{"english":"...","chinese":"...","alignment":[{"en":"word","zh":"..."}]}]
Do not add Markdown or any text outside the JSON array.`
};

/**
 * Prompt ID: learning.sentenceChecking
 * 對應功能：學習模式 → 檢查使用者英文造句
 * 呼叫位置：modules/api.js → checkUserSentence()
 * AI taskType：sentenceChecking
 * 輸出格式：純文字
 * 語言策略：跟隨介面語言
 */
export const sentenceCheckingPrompt = {
    id: 'learning.sentenceChecking',
    version: '1.0.0',
    languagePolicy: 'follow-interface',
    template: `Check whether the sentence below uses the English word "\${word}" correctly in grammar and meaning.
Sentence: "\${userSentence}"
If it is correct, return exactly: \${correctToken}
If it is incorrect, start the response exactly with: \${incorrectPrefix}
Then provide a corrected sentence and briefly explain the relevant learning point.`
};
