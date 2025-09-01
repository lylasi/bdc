# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

这是一个中文背单词学习应用（PEN子背单词），采用现代ES6模块化架构构建。应用提供词汇管理、学习模式、默写模式、测验模式和文章分析功能。

## 开发环境设置

此应用是纯前端应用，使用ES6模块：
- 使用本地HTTP服务器运行（不能直接打开HTML文件）
- 推荐使用Python: `python3 -m http.server 8000`
- 或使用Node.js的http-server: `npx http-server`

## 核心架构

### 模块化设计
应用采用功能驱动的模块化架构：

```
main.js           # 应用入口和导航控制
modules/          # 核心共享模块
├── state.js      # 全局状态管理
├── dom.js        # DOM元素选择器
├── storage.js    # localStorage操作
├── api.js        # AI API调用
├── audio.js      # 音频和TTS功能
└── ui.js         # 通用UI组件
features/         # 业务功能模块
├── vocabulary/   # 单词本管理
├── learning/     # 学习模式
├── dictation/    # 默写模式
├── quiz/         # 测验模式
└── article/      # 文章分析
```

### 状态管理
- 所有全局状态通过 `modules/state.js` 管理
- 状态更新使用 setter 函数，避免直接修改
- 关键状态包括：词汇书数据、测验进度、音频状态等

### AI集成
- 配置文件：`ai-config.js`（API密钥和模型设置）
- AI功能：单词分析、例句生成、语法检查、文章解析
- TTS服务：支持中英文语音合成

## 数据结构

### 单词本格式
```javascript
{
  id: string,           // 唯一标识符
  name: string,         // 单词本名称
  words: [              // 单词数组
    {
      word: string,     // 英文单词
      phonetic: string, // 国际音标
      meaning: string,  // 中文意思
      pos: string      // 词性
    }
  ]
}
```

### 预置单词本
- 存储在 `wordlists/` 目录
- `manifest.json` 定义可用单词本列表
- 支持动态导入和导出功能

## 开发注意事项

### 模块导入规范
- 每个功能模块导出 `init()` 函数进行初始化
- 统一在 `main.js` 中调用所有 `init()` 函数
- 模块间依赖通过明确的 import/export 声明

### 音频处理
- 使用 Web Audio API 和 TTS 服务
- 需要用户交互解锁音频上下文
- 支持暂停、继续、速度控制

### 存储机制
- 用户数据使用 localStorage 持久化
- 包括单词本、学习记录、文章历史
- 提供导入导出功能

### UI组件
- 统一的模态框系统
- 数字步进器组件
- 提示框和进度条

## 测试和调试

- 在浏览器开发者工具中查看控制台输出
- 检查 localStorage 中的数据状态
- 验证AI API连接和响应格式
- 测试各模式间的状态切换

## 重构历史

该应用从单个3000+行的app.js文件重构而来，现在采用模块化设计：
- 详细重构计划参见 `PLAN.md`
- 保持功能向后兼容
- 改进代码可维护性和可扩展性