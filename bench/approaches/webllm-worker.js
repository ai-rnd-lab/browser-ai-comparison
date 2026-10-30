// WebLLM 的 Worker 端：使用官方的 WebWorkerMLCEngineHandler。
// 網址參數 cold=1 時，下載略過 HTTP 快取（見 webllm-core.js）。
import { LIBRARY_URL, forceNoStore } from './webllm-core.js';

const params = new URL(self.location.href).searchParams;
if (params.get('cold') === '1') forceNoStore(self);
const libUrl = params.get('lib') || LIBRARY_URL;

// 先暫存早到的訊息，函式庫載入後再交給 handler
const queue = [];
self.onmessage = (msg) => queue.push(msg);
const lib = await import(/* webpackIgnore: true */ libUrl);
const handler = new lib.WebWorkerMLCEngineHandler();
self.onmessage = (msg) => handler.onmessage(msg);
for (const m of queue) handler.onmessage(m);
self.postMessage({ benchReady: true });
