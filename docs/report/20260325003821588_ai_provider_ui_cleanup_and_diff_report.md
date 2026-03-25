# AI Provider 模型列表 UI 變更與本機測試資料清理報告

## 本次處理

1. 清理了先前 Playwright 驗證留下的本機 AI 測試資料。
2. 重新檢查並整理本次 AI Provider 模型列表 UI 變更的 diff 重點。
3. 重新打開全局設定確認清理後的回填狀態正常。

## 本機測試資料清理結果

已從 `localStorage` 的 `pen_global_settings` 中移除以下測試殘留：

- `default:gpt-4.1-mini-open-state-check-a`
- `default:gpt-4.1-mini-open-state-check-b`
- `default:gpt-4.1-mini-save-check`
- `default:gpt-4.1-mini-very-long-model-name-for-layout-check`

同步清理範圍：

- `ai.providers.*.allowedModels`
- `ai.models`
- `ai.tasks`

## 清理後驗證

重新打開全局設定後確認：

- `default` provider 的允許模型列表已回到空狀態。
- `ai.models` 與 `ai.tasks` 已清空測試映射。
- 因目前沒有允許模型，8 個 task model 下拉都正確呈現 disabled。
- 畫面中的 provider empty state 正常顯示，未出現髒資料回填。

驗證觀察值：

```json
{
  "defaultAllowedModels": [],
  "models": {},
  "tasks": {},
  "disabledSelectCount": 8,
  "emptyStateCount": 8
}
```

## Diff 重點整理

### 1. `features/sync/sync.js`

關鍵位置：

- `features/sync/sync.js:345`
- `features/sync/sync.js:420`
- `features/sync/sync.js:466`
- `features/sync/sync.js:542`
- `features/sync/sync.js:849`

重點變更：

- 改用 `loadGlobalSettings()` / `loadGlobalSecrets()` 與 `saveGlobalSettings()` / `saveGlobalSecrets()` 統一讀寫本機設定。
- 導入 `listAIProviders()`、`getTaskModelSelection()`、`discoverProviderModels()`、`deriveApiUrl()`、`deriveModelsUrl()`，把 AI provider 設定改成以 provider 為中心的渲染方式。
- 新增 `buildDraftAiSettings()` / `buildDraftAiSecrets()`，在 modal 內即時組裝草稿設定，避免舊版散落的欄位讀寫。
- `renderAiSettingsSection()` 內改成 provider card + task mapping 的結構。
- 模型列表從舊的單欄文字輸入覆蓋，改為：
  - `details/summary` 收合區塊
  - checkbox + card 選擇樣式
  - discovered models + manual models 合併展示
  - 保留 `allowedModels`、manual add、discover、task dropdown 既有資料流
- 保留 rerender 後的 `<details>` 展開狀態：`modelDetailsOpenState`。
- 儲存時改由 `buildDraftAiSettings()` / `buildDraftAiSecrets()` 統一寫回，維持 `ai.models` 與 `ai.tasks` 同步。

### 2. `styles.css`

關鍵位置：

- `styles.css:3840`
- `styles.css:3905`
- `styles.css:3910`
- `styles.css:3968`
- `styles.css:3985`
- `styles.css:4078`

重點變更：

- 新增 AI provider 緊湊模型列表樣式區塊。
- 壓縮 provider card、model section、details body 的 spacing。
- 為 model option 增加固定欄寬 indicator，改善勾選指示與文字對齊。
- 將 model name 改為可顯示 2 行，降低長模型名被擠壓或嚴重截斷的問題。
- 調整 checked / hover 樣式，保留狀態感但改為更輕量的視覺表現。
- 在窄螢幕下調整 grid 欄寬與 manual input 寬度，避免爆版。

## 結論

本次收尾已完成兩件事：

- 本機測試模型與 task mapping 已清乾淨。
- UI 變更 diff 已整理，可直接對照 `features/sync/sync.js` 與 `styles.css` 的關鍵區段查看。
