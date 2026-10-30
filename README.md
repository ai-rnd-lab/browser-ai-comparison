# browser-ai-comparison

瀏覽器端 AI 方案比較與適用性評估的展示頁。

## 頁面

- [環境偵測頁](detect/)：檢查瀏覽器可使用的瀏覽器端 AI 技術，不傳送任何資料，也不下載模型。
- [量測頁](bench/)：量測框架（計時、冷暖啟動、主執行緒阻塞、JSON 匯出）。受測方案：情緒分類（Transformers.js、ONNX Runtime Web、LiteRT.js）、依文件回答問題（WebLLM + Qwen3-0.6B、Chrome 內建 AI），以及框架自我檢查。
- [內建 AI 檢查頁](builtin-ai/)：Chrome 內建 AI（Prompt API）的可用性、下載與基本量測。
- [展示頁](demo/)：情緒分類（有 WebGPU 時用顯示卡，沒有時自動改用 WebAssembly；網址加 `?force=wasm` 可示範）與依文件回答問題（Chrome 內建 AI 或 WebLLM，兩者皆不可用時停用並說明原因）。輸入內容只在瀏覽器內處理，不送到伺服器。
