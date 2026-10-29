# 量測框架（bench）

瀏覽器端 AI 方案比較用的量測頁與共用程式。版本 0.2.0；含「框架自我檢查」用的模擬方案與任務 A 的 Transformers.js 方案；ONNX Runtime Web、LiteRT.js、WebLLM、Chrome 內建 AI 於後續加入。

## 使用方式

1. 開啟量測頁：本機 `http://127.0.0.1:8000/bench/`，或 GitHub Pages 的 `bench/`。
2. 填入裝置代號與瀏覽器代號（中性代號，不要填人名或裝置自訂名稱），選擇方案、執行緒與輪數。
3. 冷啟動前先清除該瀏覽器的 HTTP 快取（見下方「冷啟動程序」），勾選確認欄位。
4. 按「開始量測」。每一輪都會重新載入頁面；量測期間請保持分頁在前景。
5. 完成後下載 JSON，存到 `results/bench/`（不納入公開 repo）。

「進階選項」欄位為 JSON，原樣傳給受測方案，用於指定量化版本、執行緒數等；欄位內容會寫入匯出的 `config.options`。

## 運作方式

- 一輪 = 一次乾淨的頁面載入：準備模型（冷啟動為 M2，暖啟動為 M3），然後連續推論 N 次。
- 輪與輪之間以 `sessionStorage` 保存進度並重新載入頁面，因此每一輪都從全新的 JavaScript 執行環境開始。
- 排程順序：每個「方案 × 執行緒」依序執行冷啟動各輪、再執行暖啟動各輪；暖啟動沿用最後一次冷啟動下載的快取。
- 冷啟動輪在載入函式庫之前，先清除 Cache Storage、IndexedDB 與 OPFS；不清除 `sessionStorage`（進度）與 Service Worker（跨來源隔離）。
- 上一輪沒有正常結束（分頁崩潰、被關閉、手動重新整理）時，該輪記為未完成並跳到下一輪，不會無限重試；未完成的輪次不計入有效樣本。

## 指標操作型定義（本版實作）

| 指標 | 起點 | 終點 | 說明 |
| --- | --- | --- | --- |
| M1 模型下載量 | 準備階段開始 | 準備階段結束 | 此區間內 Resource Timing 的 `transferSize` 加總；Worker 模式取 Worker 自己的資源紀錄 |
| M2 冷啟動準備時間 | 呼叫建立函式 | Promise resolve | 函式庫載入與 Worker 建立不計入 |
| M3 暖啟動準備時間 | 同 M2 | 同 M2 | 頁面重新載入後，模型已在快取 |
| M4 首次推論延遲 | 每輪第 1 次推論送出 | 分類：結果回傳；生成：第一個 token | 包含一次性成本 |
| M5 穩態推論延遲 | 每輪第 2 到第 N 次推論 | 同 M4 | 預設 N = 10，每輪 9 筆樣本 |
| M6 生成速度 | 第一個 token 之後 | 最後一個 token | 取每輪第 2 到第 N 次；第 1 次的原始值仍保留在 JSON |
| M9 主執行緒阻塞 | 準備或推論開始 | 結果回傳 | 每 16 ms 的心跳計時器；報告最長阻塞與總阻塞，準備階段與推論各一組 |

M7（記憶體峰值）與 M8（整合成本）不由本頁量測，M7 以活動監視器手動記錄。

## 測試資料

- 公開組：`../data/sentiment-en.json`，36 句自行撰寫的英文句子，附正負面標註。依字數分短（5 到 7 字）、中（18 到 22 字）、長（35 到 43 字）三組，每組正負面各 6 句，正負面交錯排列。標註為撰寫者的原意，不是模型輸出；不轉載任何資料集內容。
- 載入：`bench.js` 的 `loadSentences()` 回傳 `{ items, inputs, labels }`（依短、中、長輪流排列，前 10 句涵蓋三種長度），受測方案在 `getInputs()` 使用 `inputs`，並以 `items` 的標註比對輸出。
- 本機組：SST-2 驗證集只放在專案根目錄的 `data/raw/`（不納入版本紀錄、不推送），僅在 Mac mini 檢查準確率。

## 受測方案介面

新方案在 `approaches/` 新增模組並於 `approaches/index.js` 登錄。完整說明見 `bench.js` 的 `runRound` 註解，重點如下：

- `load(ctx)`：載入函式庫、建立 Worker；不計時。
- `create(ctx)`：計時範圍（M2 或 M3），回傳 handle。
- `infer(handle, input, hooks)`：生成任務每產生 token 呼叫 `hooks.onToken(n)`。
- `getTransferBytes(handle, sinceEpochMs)`：Worker 模式必須由 Worker 回報自己的傳輸量（可用 `worker-runtime.js` 內建的 `__resourceBytes__`）。
- 參考實作：`approaches/selftest.js`。

## 受測方案：Transformers.js + DistilBERT（任務 A）

- 函式庫 Transformers.js 4.3.1（jsdelivr 的 `dist/transformers.min.js`），模型 `Xenova/distilbert-base-uncased-finetuned-sst-2-english`。支援主執行緒與 Worker。
- 進階選項（JSON）：`dtype`（`fp16` 預設、`int8`、`fp32`）、`device`（`webgpu` 預設、`wasm`）、`numThreads`（1 到 32，只影響 wasm，例如單執行緒對照）。另有本機驗證用的 `libraryUrl`、`wasmPaths`、`remoteHost`、`expectedBytes`，以及除錯用的 `trace`。
- 每輪逾時：頁面有「每輪逾時（秒）」欄位（預設 300）。超時的輪次記為 `timeout`、不計入有效樣本，並自動重新載入、繼續排程。
- 冷啟動的 M1 包含預設的 WebAssembly 執行檔（約 27 MB，來自 jsdelivr）；函式庫的進度事件在快取命中時也會觸發，因此「函式庫位元組」不等於下載量，僅用於冷啟動檢查的輔助判斷。
- 冷啟動檢查狀態：`ok`、`ok-library`（transferSize 不可用但函式庫回報足量位元組）、`unavailable`、`suspect-cached`；暖啟動：`ok`、`suspect-not-cached`、`suspect-downloaded`。
- 每輪記錄準確率（輸出標籤與標註比對），彙整表有準確率欄。
- 已知現象：主執行緒 + 多執行緒 wasm 在無頭 Chromium 的第二次載入曾卡住，原因未查明；逾時保護會把該輪記為 timeout。真機結果以 Mac mini 為準。
- 本機驗證只用假模型（非 DistilBERT），僅證明流程；真實模型數據尚未量測。

## 冷啟動程序

網頁無法清除 HTTP 快取。每台裝置的冷啟動量測前，請用新的瀏覽器設定檔，或以瀏覽器的「清除網站資料」功能清除受測網站的資料，再勾選頁面上的確認欄位。頁面會以 M1 事後檢查：冷啟動輪的傳輸量低於預期模型大小的 80% 時標記為 `suspect-cached`，該輪冷啟動數據應存疑。

## 已知限制

- 心跳解析度：長度為 B 的阻塞，實際被量到的延遲落在 B − 16 到 B ms；短於 16 ms 的阻塞可能完全量不到。
- 同源資源經 Service Worker（跨來源隔離用）處理，頁面看不到實際網路傳輸量，`transferSize` 為 0。這類情況冷啟動檢查回報 `unavailable`，不下結論。模型檔來自 Hugging Face 與 CDN（跨來源）時不受此影響，但仍須對方提供 `Timing-Allow-Origin`，否則 `transferSize` 同樣為 0，也回報 `unavailable`。
- 目前只在無頭 Chromium 驗證；Safari、Firefox 與 iOS 尚未驗證。
- 頁面使用 `Cross-Origin-Embedder-Policy: require-corp`，跨來源的函式庫與模型檔須回應 CORS 標頭才能載入；尚未以真實的 CDN 與模型庫驗證。
- 背景分頁的計時器會被降頻；量測期間分頁曾進入背景的輪次標記為 `hidden-during-run`，不計入有效樣本。

## 框架自我檢查結果（2026-10-29，無頭 Chromium，模擬方案）

模擬方案的準備階段含 150 ms 等待與 100 ms 同步運算，推論含 40 到 60 ms 同步運算；Worker 與主執行緒各 5 輪冷啟動、5 輪暖啟動。

| 檢查項目 | 結果 |
| --- | --- |
| 冷啟動比暖啟動多約 150 ms（模擬下載時間） | 冷 259 到 265 ms，暖 102 ms（中位數） |
| 主執行緒準備階段最長阻塞（同步運算 100 ms） | 85.5 到 86.6 ms，落在預期的 84 到 100 ms |
| Worker 準備階段最長阻塞 | 0.2 到 0.5 ms |
| 主執行緒推論最長阻塞（同步運算 40 到 60 ms） | 34.0 ms（24.0 到 44.2），落在預期範圍 |
| Worker 推論最長阻塞 | 中位數 0.2 到 0.3 ms |
| 跨來源下載 65,536 位元組檔案的 M1 | 65,836 位元組（含標頭），主執行緒與 Worker 一致 |
| 暖啟動 M1 | 0 位元組 |
| 同源下載的冷啟動檢查 | 回報 `unavailable`，未誤判為快取 |
| 量測中途強制重新整理 | 該輪記為未完成，排程繼續，不計入有效樣本 |

這些數字只證明框架的計時與判斷邏輯，不是任何受測方案的效能數據。
