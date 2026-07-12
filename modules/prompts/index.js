import { normalizeLocale } from '../i18n-config.js';
import { AI_LANGUAGE_RULES } from './language-rules.js';
import { wordAnalysisPrompt } from './dictionary.js';
import { exampleGenerationPrompt, sentenceCheckingPrompt } from './learning.js';
import {
    paragraphTranslationPrompt,
    phraseAnalysisPrompt,
    sentenceAnalysisPrompt,
    wordTooltipPrompt
} from './article.js';
import { answerCheckingPrompt } from './qa.js';
import { extractTextPrompt, handwritingGradingJsonPrompt } from './ocr.js';
import { handwritingGradingMarkdownPrompt } from './dictation.js';
import { articleTutorPrompt } from './assistant.js';
import { htmlExtractionPrompt, markdownCleanupPrompt } from './import.js';

const promptRegistry = {
    [wordAnalysisPrompt.id]: wordAnalysisPrompt,
    [exampleGenerationPrompt.id]: exampleGenerationPrompt,
    [sentenceCheckingPrompt.id]: sentenceCheckingPrompt,
    [paragraphTranslationPrompt.id]: paragraphTranslationPrompt,
    [wordTooltipPrompt.id]: wordTooltipPrompt,
    [sentenceAnalysisPrompt.id]: sentenceAnalysisPrompt,
    [phraseAnalysisPrompt.id]: phraseAnalysisPrompt,
    [answerCheckingPrompt.id]: answerCheckingPrompt,
    [extractTextPrompt.id]: extractTextPrompt,
    [handwritingGradingJsonPrompt.id]: handwritingGradingJsonPrompt,
    [handwritingGradingMarkdownPrompt.id]: handwritingGradingMarkdownPrompt,
    [articleTutorPrompt.id]: articleTutorPrompt,
    [markdownCleanupPrompt.id]: markdownCleanupPrompt,
    [htmlExtractionPrompt.id]: htmlExtractionPrompt
};

function applyTemplate(template, params = {}) {
    return String(template || '').replace(/\$\{(\w+)\}/g, (match, key) => (
        Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match
    ));
}

export function getPromptDefinition(promptId) {
    const definition = promptRegistry[promptId];
    if (!definition) throw new Error(`Unknown prompt: ${promptId}`);
    return definition;
}

export function getPromptVersion(promptId) {
    return getPromptDefinition(promptId).version;
}

function resolveTemplate(definition, variant) {
    if (variant && definition.variants?.[variant]) return definition.variants[variant];
    return definition.template || '';
}

export function buildPrompt(promptId, params = {}, { locale = 'zh-CN', variant } = {}) {
    const definition = getPromptDefinition(promptId);
    const taskPrompt = applyTemplate(resolveTemplate(definition, variant), params);
    if (definition.languagePolicy !== 'follow-interface') return taskPrompt;
    return `${AI_LANGUAGE_RULES[normalizeLocale(locale)]}\n\n${taskPrompt}`;
}

export function buildMessages(promptId, params = {}, { locale = 'zh-CN', variant } = {}) {
    const definition = getPromptDefinition(promptId);
    const taskPrompt = applyTemplate(resolveTemplate(definition, variant), params);
    let systemPrompt = applyTemplate(definition.system || '', params);
    if (definition.languagePolicy === 'follow-interface') {
        systemPrompt = [systemPrompt, AI_LANGUAGE_RULES[normalizeLocale(locale)]].filter(Boolean).join('\n\n');
    }
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    if (taskPrompt) messages.push({ role: 'user', content: taskPrompt });
    return messages;
}
