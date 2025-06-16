// AI 配置
const API_URL = 'https://tbai.xin/v1/chat/completions';
const API_KEY = 'sk-Cy8AfiJ0rVilVPkLGaoFmxMJaIivel4boHDdoX42bHtnLmnb'; // 請替換成你的 API Key

// AI 模型配置
const AI_MODELS = {
    // 用於生成例句
    exampleGeneration: "gpt-4.1-nano",
    // 用於在上下文中分析單詞
    wordAnalysis: "gpt-4.1-nano",
    // 用於檢查句子語法
    sentenceChecking: "gpt-4.1-nano"
};