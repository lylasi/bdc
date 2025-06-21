// AI 配置
const API_URL = 'https://xxx.xxx/v1/chat/completions';
const API_KEY = ''; // 請替換成你的 API Key

// AI 模型配置
const AI_MODELS = {
    // 用於生成例句
    exampleGeneration: "gpt-4.1-nano",
    // 用於在上下文中分析單詞
    wordAnalysis: "gpt-4.1-nano",
    // 用於檢查句子語法
    sentenceChecking: "gpt-4.1-nano"
};


// TTS 服務配置
const TTS_CONFIG = {
    baseUrl: 'https://xxx.1414.xyz',
    apiKey: 'xxxxx',
    voices: {
        english: 'en-US-JennyNeural',
        chinese: 'zh-CN-XiaoxiaoNeural'
    }
};
