# scripts 使用說明（繁體中文）

本資料夾放置本專案的輔助腳本。以下列出重點腳本的用途、依賴與使用方式，方便之後維護與更新。

> 提示：路徑均以專案根目錄為基準。範例命令在 macOS/Linux 的 bash/zsh 環境下可直接執行。

## TTS 聲音清單（voices）相關

### 1) scripts/update-voices.sh
- 作用：
  - 從指定 TTS 服務端下載完整 voices 清單，保存成 voices.json。
  - 生成精簡版 voices.min.json，只保留以下四大類（含常見別名）：
    - 英語（美音）en-US
    - 英語（英音）en-GB
    - 中文（普通話）zh-CN + zh-TW
    - 中文（粵語）zh-HK + 以 yue-* 開頭者
  - 精簡檔的欄位僅包含：id（short_name 優先）、locale、gender、localName、displayName。
- 依賴：需要 curl；精簡輸出需系統安裝 node（若無 Node，將跳過精簡步驟）。
- 用法：
  - 預設來源（專案既定遠端）：
    ```bash
    bash scripts/update-voices.sh
    ```
  - 指定來源（自定義服務）：
    ```bash
    bash scripts/update-voices.sh 'https://your-tts.example.com/voices'
    ```
- 產物：
  - voices.json（完整清單）
  - voices.min.json（精簡清單，前端優先讀取）
- 前端讀取順序（modules/voices.js）：
  1. /voices.min.json（同源、無 CORS）
  2. /voices.json
  3. localStorage 快取（若本地靜態不可讀）
  4. 僅在「重新載入清單」且本地靜態不可用時，才嘗試遠端 /voices 更新快取

### 2) scripts/compact-voices.mjs
- 作用：從完整 voices.json 產生精簡版 voices.min.json。
- 用法：
  ```bash
  node scripts/compact-voices.mjs voices.json voices.min.json
  ```
- 選取規則：保留 en-US、en-GB、zh-CN、zh-HK、zh-TW、yue-*。
- 欄位正規化：id 以 short_name/ShortName 為主，並保留 locale/gender/localName/displayName。

## 字型子集與內容生成

### 3) scripts/build-font-subset.sh
- 作用：打包/構建字型子集（依專案定制流程）。
- 依賴：需要字型子集工具（例如 pyftsubset 或其他），請視腳本內註解與專案 README 配置。
- 用法：
  ```bash
  bash scripts/build-font-subset.sh
  ```

### 4) scripts/gen-subset-chars.js
- 作用：掃描內容來源，輸出字型子集所需字元集（供子集工具使用）。
- 用法：
  ```bash
  node scripts/gen-subset-chars.js
  ```

### 5) scripts/generate-from-5a-jumpstart.js / scripts/generate-from-5a-texts.js
- 作用：從既有資料（5A 系列）生成文章/素材到專案目錄。
- 用法：
  ```bash
  node scripts/generate-from-5a-jumpstart.js
  node scripts/generate-from-5a-texts.js
  ```

### 6) scripts/extract-5a-readings.js
- 作用：從 5A 資料中擷取閱讀片段，整理成適用於專案的格式。
- 用法：
  ```bash
  node scripts/extract-5a-readings.js
  ```

## 建議維護流程（TTS）
1. 更新 voices 清單：
   ```bash
   bash scripts/update-voices.sh
   ```
2. 啟動本地服務，打開「全局設定」→「重新載入清單」確認精簡清單顯示與試聽。
3. 若要固定某些模型：在全局設定選擇後儲存；前端會持久化於本機。

## 注意事項
- voices.min.json 會大幅縮小載入體積（僅需數十 KB），建議每次更新完 voices.json 都同步生成精簡版。
- 若 TTS 服務端更換或新增語系，請同步調整 scripts/compact-voices.mjs 裡的保留規則。
- 若沒有 Node.js，update-voices.sh 仍會下載 voices.json，只是不會生成 voices.min.json；前端會回退讀取 voices.json。

如需更多自動化（例如加入 npm script、CI 定期更新 voices），可在此基礎上擴充。

