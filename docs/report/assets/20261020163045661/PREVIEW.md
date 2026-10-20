# 文章閱讀檔案預覽

此目錄的截圖與匯出檔由 `tests/reading-preview.cjs` 使用獨立瀏覽器 context 與合成資料產生。
不會讀取使用者既有瀏覽器資料、正式帳號或 `ai-config.js` 金鑰；所有外部網路請求会被阻斷。

重現方式：

```bash
python3 scripts/serve.py --port 8313
PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> ASSET_DIR=/Users/linus/CODE/bdc/docs/report/assets/20261020163045661 node tests/reading-preview.cjs
```

fixture：`fixture.json`。文章為 Meeting Follow-up；已查短語 look forward to、單詞 look、句子，含筆記、詞書關聯、70 條消息與引用真實消息 ID 的 AI 文件。

注意：這是合成資料的本機 UI，不代表任何正式帳號的雲端內容。