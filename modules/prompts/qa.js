/**
 * Prompt ID: qa.answerChecking
 * 對應功能：QA 訓練 → AI 智能校對學生答案
 * 呼叫位置：features/qa/qa-checker.js → performAIAnalysis()
 * AI taskType：qaChecking
 * 輸出格式：JSON object
 * 語言策略：跟隨介面語言
 */
export const answerCheckingPrompt = {
    id: 'qa.answerChecking',
    version: '1.0.0',
    languagePolicy: 'follow-interface',
    system: 'You are a strict but helpful English question-answer grader. Return only strict JSON without Markdown fences or extra text.',
    template: `Question: \${question}
Reference answer: \${correctAnswer}
Student answer: \${userAnswer}

Compare the student answer with the question and reference answer. Check meaning, grammar, spelling, vocabulary, sentence structure, capitalization and punctuation.
Return only this JSON structure:
{
  "isCorrect": true/false,
  "teacherFeedback": "complete and precise feedback",
  "improvementSuggestions": ["specific improvement"],
  "studyFocus": ["knowledge point to review"],
  "errors": {
    "grammar": [],
    "spelling": [],
    "vocabulary": [],
    "structure": [],
    "punctuation": []
  }
}
Rules:
- Use the reference answer as the grading basis and require a direct answer to the question.
- Check capitalization and punctuation as well as grammar and meaning.
- If the answer only comments on or agrees with the reference without directly answering the question, mark it incorrect.
- Do not add fields outside this structure.`
};
