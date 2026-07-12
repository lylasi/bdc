/**
 * Prompt ID: import.markdownCleanup
 * 對應功能：文章匯入 → 清理已抽取的 Markdown
 * 呼叫位置：modules/api.js → aiCleanArticleMarkdown()
 * AI taskType：articleCleanup
 * 輸出格式：Markdown
 * 語言策略：保留來源語言，不跟隨介面
 */
export const markdownCleanupPrompt = {
    id: 'import.markdownCleanup',
    version: '1.0.0',
    languagePolicy: 'preserve-source',
    system: 'You are a precise Markdown editor that preserves structure and removes noise without translating.',
    template: `Clean the supplied Markdown article for reading.
- Keep the main content and necessary headings, paragraphs, lists, tables, blockquotes and genuine code blocks.
- Remove navigation, language selectors, social buttons, recommendations, advertisements, copyright notices, comments, tracking images and counters.
- \${imageRule}
- Do not add bold or italic decoration. Remove decorative separators and meaningless symbols.
- Keep readable links but remove tracking parameters. Do not repair relative links in this step.
- Preserve the original language, wording and Simplified or Traditional Chinese character form. Do not translate or add commentary.
- Return only cleaned Markdown without a code fence.

=== Source Markdown ===
\${markdownText}
=== End Source ===`
};

/**
 * Prompt ID: import.htmlExtraction
 * 對應功能：文章匯入 → 從 HTML 擷取正文並輸出 Markdown
 * 呼叫位置：modules/api.js → aiExtractArticleFromHtml()
 * AI taskType：articleCleanup
 * 輸出格式：Markdown
 * 語言策略：保留來源語言，不跟隨介面
 */
export const htmlExtractionPrompt = {
    id: 'import.htmlExtraction',
    version: '1.0.0',
    languagePolicy: 'preserve-source',
    system: 'You are a precise content extractor that outputs clean Markdown. Do not translate or add commentary.',
    template: `Base URL: \${url}
Extract the main article from the supplied HTML and return Markdown only.
- Preserve headings, paragraphs, lists, tables, blockquotes and genuine code blocks.
- \${imageRule}
- Remove navigation, sidebars, footers, cookie notices, language selectors, social sharing, recommendations, advertisements, comments and copyright notices.
- Do not add decorative emphasis, separators or meaningless icons.
- Convert relative links and retained image URLs to absolute URLs using the Base URL.
- Remove tracking parameters and redundant whitespace without rewriting the source wording.
- Preserve the original language and Simplified or Traditional Chinese character form.
- Do not use a Markdown code fence or add commentary.

=== Source HTML ===
\${html}
=== End Source ===`
};
