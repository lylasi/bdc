import { API_URL, API_KEY, AI_MODELS } from '../ai-config.js';

// =================================
// AI API 服務
// =================================

/**
 * 通用的 AI API 請求函數
 * @param {string} model - 使用的 AI 模型
 * @param {string} prompt - 發送給 AI 的提示
 * @param {number} temperature - 控制生成文本的隨機性
 * @returns {Promise<any>} - 返回 AI 的響應內容
 */
async function fetchAIResponse(model, prompt, temperature = 0.5) {
    const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`
        },
        body: JSON.stringify({
            model: model,
            messages: [{ role: "user", content: prompt }],
            temperature: temperature,
        })
    });

    if (!response.ok) {
        const errorData = await response.json();
        console.error('API Error:', errorData);
        throw new Error(`API請求失敗，狀態碼: ${response.status}`);
    }

    const data = await response.json();
    let content = data.choices[0].message.content.replace(/^```json\n/, '').replace(/\n```$/, '').trim();
    
    try {
        return JSON.parse(content);
    } catch (error) {
        console.warn("JSON 解析失敗，將返回原始文本內容。", `錯誤: ${error.message}`);
        return content; // 如果解析失敗，返回原始字符串
    }
}

/**
 * 獲取單個單詞的詳細分析（音標、詞性、中文意思）。
 * @param {string} word - 要分析的單詞。
 * @returns {Promise<object>} - 包含分析結果的對象。
 */
export async function getWordAnalysis(word) {
    try {
        const prompt = `Please provide a detailed analysis for the word "${word}". Return the result in a strict JSON format with the following keys: "phonetic" (IPA), "pos" (part of speech), and "meaning" (the most common Traditional Chinese meaning). For example: {"phonetic": "ɪɡˈzæmpəl", "pos": "noun", "meaning": "例子"}. Ensure the meaning is in Traditional Chinese.`;
        return await fetchAIResponse(AI_MODELS.wordAnalysis, prompt, 0.2);
    } catch (error) {
        console.error(`Error analyzing word "${word}":`, error);
        return { phonetic: 'error', pos: '', meaning: '分析失敗' };
    }
}

/**
 * 為指定單詞生成例句。
 * @param {string} word - 需要例句的單詞。
 * @returns {Promise<Array>} - 包含例句對象的數組。
 */
export async function generateExamplesForWord(word) {
    const prompt = `請為單詞 "${word.word}" 生成3個英文例句。對於每個例句，請提供英文、中文翻譯，以及一個英文單詞到中文詞語的對齊映射數組。請確保對齊盡可能精確。請只返回JSON格式的數組，不要有其他任何文字。格式為: [{"english": "...", "chinese": "...", "alignment": [{"en": "word", "zh": "詞語"}, ...]}, ...]`;
    return await fetchAIResponse(AI_MODELS.exampleGeneration, prompt, 0.7);
}

/**
 * 檢查用戶造句的正確性。
 * @param {string} word - 句子中使用的核心單詞。
 * @param {string} userSentence - 用戶創建的句子。
 * @returns {Promise<string>} - AI 的反饋文本。
 */
export async function checkUserSentence(word, userSentence) {
    const prompt = `請判斷以下這個使用單詞 "${word}" 的句子在語法和用法上是否正確: "${userSentence}"。如果正確，請只回答 "正確"。如果不正確，請詳細指出錯誤並提供一個修改建議，格式為 "不正確。建議：[你的建議]"。並總結錯誤的知識點。`;
    return await fetchAIResponse(AI_MODELS.sentenceChecking, prompt, 0.5);
}

/**
 * 分析文章中的單個段落。
 * @param {string} paragraph - 要分析的段落。
 * @returns {Promise<object>} - 包含段落分析結果的對象。
 */
export async function analyzeParagraph(paragraph) {
    const prompt = `請對以下英文段落進行全面、深入的語法和語義分析，並嚴格按照指定的JSON格式返回結果。

段落: "${paragraph}"

請返回一個JSON對象，包含以下三個鍵:
1. "chinese_translation": 字符串，為此段落的流暢中文翻譯。
2. "word_alignment": 數組，每個元素是一個對象 {"en": "英文單詞", "zh": "對應的中文詞語"}，用於實現英漢詞語對照高亮。
3. "detailed_analysis": 一個 **數組**，其中每個元素都是一個對象，代表段落中一個具體單詞的分析。
   - **重要**: 這個數組中的對象必須嚴格按照單詞在原文中出現的順序排列。
   - **重要**: 如果同一個單詞在段落中出現多次，請為每一次出現都創建一個獨立的分析對象。
   - 每個對象的結構如下:
     {
       "word": "被分析的單詞原文",
       "sentence": "該單詞所在的完整句子",
       "analysis": {
         "phonetic": "該單詞的國際音標(IPA)，例如 'ˈæpəl'",
         "pos": "詞性",
         "meaning": "在當前上下文中的準確中文意思",
         "role": "在句子中的極其詳細的語法作用，並強力關聯上下文。描述必須非常具體，清晰地闡述該詞與前後文的邏輯關係。"
       }
     }

請只返回JSON格式的數據，不要包含任何額外的解釋性文字或標記。
**極其重要**: JSON值內的所有雙引號都必須使用反斜杠進行轉義 (例如，寫成 \\" 而不是 ")。`;
    
    // 針對這個複雜的解析，我們直接在這裡處理，而不是用通用解析器
    const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`
        },
        body: JSON.stringify({
            model: AI_MODELS.exampleGeneration,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.5,
        })
    });

    if (!response.ok) {
        const errorData = await response.json();
        console.error('API Error:', errorData);
        throw new Error(`API請求失敗，狀態碼: ${response.status}`);
    }

    const data = await response.json();
    let content = data.choices[0].message.content.replace(/^```json\n/, '').replace(/\n```$/, '').trim();

    try {
        return JSON.parse(content);
    } catch (error) {
        console.warn("常規 JSON 解析失敗，啟動備用解析策略。", `錯誤: ${error.message}`);
        // 嘗試修復常見的 AI 生成錯誤
        let fixedContent = content.replace(/([\w'])\"(\s*[,}])/g, '$1$2');
        if (content !== fixedContent) {
            try {
                return JSON.parse(fixedContent);
            } catch (e1) {
                console.warn("啟發式修復後解析失敗。", `錯誤: ${e1.message}`);
            }
        }
        // 如果所有方法都失敗了，拋出原始錯誤
        throw error;
    }
}