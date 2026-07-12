/**
 * Prompt ID: article.paragraphTranslation
 * 對應功能：文章詳解 → 段落翻譯及 Markdown 結構保留
 * 呼叫位置：modules/api.js → analyzeParagraph()
 * AI taskType：articleParagraphTranslation
 * 輸出格式：JSON object
 * 語言策略：跟隨介面語言
 */
export const paragraphTranslationPrompt = {
    id: 'article.paragraphTranslation',
    version: '1.0.0',
    languagePolicy: 'follow-interface',
    variants: {
        standard: `Translate the following English paragraph into the target Chinese language.
Return only strict JSON: {"chinese_translation":"..."}
Do not return word_alignment or detailed_analysis.
Keep English personal names unchanged.
If the paragraph contains Markdown tables, lists, headings, images or links, preserve all Markdown markers and line structure exactly. Do not translate or rewrite image syntax or image alt text.

Paragraph:
"""
\${paragraph}
"""`,
        sentences: `Translate the following \${count} numbered English sentences one by one into the target Chinese language.
Return only strict JSON: {"sentences":["translation 1","translation 2"]}
The sentences array must contain exactly \${count} strings in the original order.
Do not merge or split sentences. Do not include the English source sentences or numbering. Keep English personal names unchanged.

Sentences:
\${numbered}`,
        fallback: `Translate the following English paragraph into the target Chinese language.
Return only strict JSON: {"chinese_translation":"..."}

Paragraph:
"""
\${paragraph}
"""`
    }
};

/**
 * Prompt ID: article.wordTooltip
 * 對應功能：文章詳解 → 點選單字後顯示句中意思
 * 呼叫位置：modules/api.js → analyzeWordInSentence()
 * AI taskType：articleWordTranslation
 * 輸出格式：JSON object
 * 語言策略：跟隨介面語言
 */
export const wordTooltipPrompt = {
    id: 'article.wordTooltip',
    version: '1.0.0',
    languagePolicy: 'follow-interface',
    variants: {
        standard: `Analyze the target English word in its sentence.
Return only strict JSON:
{"word":"...","sentence":"...","analysis":{"phonetic":"IPA","pos":"part of speech","meaning":"Chinese meaning in this sentence","role":"brief grammatical role"}}

Target word: "\${word}"
Sentence: "\${sentence}"`,
        fallback: `Give only the target Chinese meaning of the English word in this sentence. Do not add an explanation.
Word: \${word}
Sentence: \${sentence}`
    }
};

/**
 * Prompt ID: article.sentenceAnalysis
 * 對應功能：文章詳解 → 單句翻譯、結構及重點分析
 * 呼叫位置：modules/api.js → analyzeSentence()
 * AI taskType：articleSentenceTranslation
 * 輸出格式：JSON object
 * 語言策略：跟隨介面語言
 */
export const sentenceAnalysisPrompt = {
    id: 'article.sentenceAnalysis',
    version: '1.0.0',
    languagePolicy: 'follow-interface',
    variants: {
        structured: `Analyze the target English sentence and return only strict JSON:
{
  "sentence":"original sentence",
  "translation":"target Chinese translation",
  "phrase_alignment":[{"en":"...","zh":"..."}],
  "chunks":[{"text":"...","role":"...","note":"..."}],
  "key_points":["..."]
}
\${keyPointRule}

Context for understanding only:
"""
\${context}
"""
Target sentence:
"""
\${sentence}
"""`,
        concise: `Translate and briefly analyze the target English sentence.
Return only strict JSON:
{"sentence":"original sentence","translation":"target Chinese translation","key_points":["..."]}
\${keyPointRule}

Context for understanding only:
"""
\${context}
"""
Target sentence:
"""
\${sentence}
"""`,
        fallback: `Translate the following English sentence into the target Chinese language and, if possible, add 1-2 brief key points.
Return JSON or only the translated text.
Sentence: \${sentence}`
    }
};

/**
 * Prompt ID: article.phraseAnalysis
 * 對應功能：文章詳解 → 選中片語分析
 * 呼叫位置：modules/api.js → analyzeSelection()
 * AI taskType：articlePhraseTranslation
 * 輸出格式：JSON object
 * 語言策略：跟隨介面語言
 */
export const phraseAnalysisPrompt = {
    id: 'article.phraseAnalysis',
    version: '1.0.0',
    languagePolicy: 'follow-interface',
    variants: {
        standard: `Analyze the selected English phrase in its sentence.
Provide IPA for the whole phrase when reliable; otherwise provide word-by-word IPA separated by spaces.
Return only strict JSON:
{"selection":"...","sentence":"...","analysis":{"phonetic":"IPA","meaning":"...","usage":"...","examples":[{"en":"...","zh":"..."}]}}

Selected phrase: "\${selection}"
Sentence: "\${sentence}"
Context: "\${context}"`,
        fallback: `Give only the target Chinese meaning of the selected English phrase in this sentence. Do not add an explanation.
Phrase: \${selection}
Sentence: \${sentence}`
    }
};
