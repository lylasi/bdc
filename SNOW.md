# SNOW.md

## Project Name
**PEN子背單詞 (PEN's Word Memorizing App)**
一個功能豐富、注重離線體驗與AI增強的單頁式（SPA）語言學習應用。

## Overview
“PEN子背單詞”是一個純靜態前端應用，旨在提供全面的英語單詞學習體驗。它採用現代 JavaScript (ES Modules) 技術，無需後端服務器即可在瀏覽器中獨立運行。該應用集成了多種學習工具，從基礎的單詞本管理，到高級的 AI 輔助功能，如文章分析、圖片文字識別（OCR）和智能問答訓練。此外，項目還通過 Supabase 實現了數據的雲端同步，確保用戶在不同設備間的學習進度保持一致。其模塊化的架構設計清晰，易於維護和擴展。

## Technology Stack
- **Language/Runtime**: HTML5, CSS3, JavaScript (ES2022)
- **Framework(s)**: Vanilla JS (無主框架)
- **Key Dependencies**:
    - **Cloud Sync**: Supabase
    - **AI Services**: 通過 `modules/api.js` 封裝的外部 AI 接口
    - **Local Storage**: IndexedDB 和 localStorage 雙層快取
- **Build Tools**: 無。通過 `npx serve` 或 `http-server` 直接運行。

## Project Structure
```
/
├── index.html              # 應用主入口 HTML 文件
├── main.js                 # JavaScript 主入口，負責模塊初始化與導航
├── styles.css              # 全局樣式表
├── modules/                # 核心共享模塊
│   ├── state.js            # 全局狀態管理
│   ├── dom.js              # DOM 元素選擇器集中管理
│   ├── storage.js          # 本地存儲 (localStorage/IndexedDB)
│   ├── api.js              # 外部 AI 服務 API 請求封裝
│   ├── audio.js            # 音頻播放 (TTS) 控制
│   ├── ui.js               # 通用 UI 組件 (Modal, Tooltip 等)
│   └── ...                 # 其他共享服務 (settings, cache, sync, etc.)
├── features/               # 業務功能模塊
│   ├── vocabulary/         # 單詞本管理
│   ├── dictation/          # 默寫模式
│   ├── learning/           # 學習模式
│   ├── quiz/               # 隨堂測驗
│   ├── article/            # 文章詳解
│   ├── ocr/                # 圖片文字識別 (OCR)
│   ├── qa/                 # 問答訓練
│   ├── sync/               # 雲端同步
│   └── assistant/          # AI 助手
├── wordlists/              # 預設單詞本數據 (JSON)
├── articles/               # 預設文章數據 (JSON)
├── qa-sets/                # 問答訓練數據 (JSON)
├── scripts/                # 工具腳本 (如更新語音列表)
├── ai-config.example.js    # AI 服務配置範例文件
└── AGENTS.md/CLAUDE.md     # 給開發者和 AI 代理的詳細項目文檔
```

## Key Features
- **單詞本管理**: 創建、編輯、刪除、合併、導入/導出單詞本。
- **默寫模式**: 可自定義重複次數、間隔，並支持 AI 批改手寫圖片。
- **學習模式**: 提供單詞的 AI 詳解、例句生成和發音。
- **隨堂測驗**: 支持多種題型（看英文選中文、看中文選英文等）。
- **文章詳解**: 導入文章進行 AI 分析，支持段落/句子級朗讀和翻譯遮罩。
- **圖片文字識別 (OCR)**: 從圖片或攝像頭捕獲文字，支持高級提示詞和 Markdown 預覽。
- **問答訓練**: 創建和訓練自定義問答集，支持 AI 校對和 PDF 導出。
- **雲端同步**: 通過 Supabase 在多設備間同步學習數據。
- **AI 助手**: 在文章閱讀時提供上下文輔助。

## Getting Started

### Prerequisites
- 一個現代網頁瀏覽器 (如 Chrome, Firefox, Safari, Edge)。
- Node.js (用於運行本地服務器)。

### Installation
此項目無需傳統安裝。只需一個本地 HTTP 服務器即可運行。

1.  **克隆或下載項目到本地。**
2.  **配置 AI (可選)**:
    如果需要使用 AI 功能，複製 `ai-config.example.js` 為 `ai-config.js`，並填入您的 API 金鑰和模型配置。
    ```bash
    cp ai-config.example.js ai-config.js
    ```
3.  **啟動本地服務器**:
    在項目根目錄下，運行以下任一命令：
    ```bash
    # 推薦，自動監聽文件變更
    npx serve .
    ```
    或者，如果需要禁用緩存以方便調試：
    ```bash
    npx http-server -c-1 .
    ```

### Usage
服務器啟動後，在瀏覽器中打開提供的 URL (通常是 `http://localhost:3000` 或 `http://localhost:8080`) 即可開始使用。

## Development

### Available Scripts
項目不使用 `npm scripts`。所有輔助任務通過 `scripts/` 目錄下的 shell 或 JS 腳本執行，例如：
- `scripts/update-voices.sh`: 更新支持的 TTS 語音列表。

### Development Workflow
1.  **修改代碼**: 直接修改 `features/` 或 `modules/` 下的 JavaScript 文件。
2.  **遵循規範**:
    - **DOM 操作**: 所有 DOM 選擇器必須在 `modules/dom.js` 中定義。
    - **狀態管理**: 全局狀態應在 `modules/state.js` 中管理。
    - **代碼風格**: 遵循項目已有的風格（ES2022, 4空格縮進, 單引號）。
3.  **測試**: 在瀏覽器中手動測試相關功能。由於缺乏自動化測試，重大變更後建議對所有核心模組進行回歸測試。

## Configuration
- **AI/雲端配置**: 核心配置位於根目錄的 `ai-config.js` 文件中（此文件不應提交到版本控制）。它控制著 AI 模型選擇、API 端點、TTS 服務和雲端同步等功能。
- **應用內配置**: 用戶特定的偏好設置（如朗讀速度、界面主題等）存儲在瀏覽器的 `localStorage` 中。

## Architecture
項目採用分層的模塊化架構：
1.  **表示層 (Presentation Layer)**: `index.html` 和 `styles.css` 負責靜態佈局和樣式。
2.  **功能層 (Feature Layer)**: `features/` 目錄下的各個模塊，每個模塊封裝一個獨立的業務功能，並暴露一個 `init()` 函數供主程序調用。
3.  **服務層 (Service Layer)**: `modules/` 目錄下的共享模塊，為所有功能模塊提供底層、可復用的服務，如狀態管理、DOM 操作、API 請求和本地存儲。
這種架構實現了高度的“關注點分離”，使得代碼更易於維護和擴展。

## License
項目中未指定明確的開源許可證。
