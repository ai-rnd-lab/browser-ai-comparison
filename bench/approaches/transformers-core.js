// Transformers.js 方案核心（情緒分類，DistilBERT），主執行緒與 Worker 共用。
// 函式庫版本固定，載入方式見 loadLibrary。
import { resourceBytes } from '../bench.js';

export const LIBRARY_VERSION = '4.3.1';
export const LIBRARY_URL = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${LIBRARY_VERSION}/dist/transformers.min.js`;
export const MODEL_ID = 'Xenova/distilbert-base-uncased-finetuned-sst-2-english';

// 各量化版本的預期檔案大小（位元組），來源：Hugging Face 模型頁 onnx 資料夾，2026-10-29 查閱。
// 用於冷啟動檢查，不用於計算任何指標。
export const EXPECTED_BYTES = { fp32: 268e6, fp16: 134e6, int8: 67.4e6 };

let lib = null;
let classifier = null;
let libraryBytes = 0;

// 載入函式庫（不計入準備時間）。
export async function loadLibrary(url = LIBRARY_URL) {
  if (!lib) lib = await import(/* webpackIgnore: true */ url);
  return lib;
}

// 建立分類器（計入準備時間）。
// options：dtype（fp16、int8、fp32）、device（webgpu、wasm）、numThreads（只影響 wasm）、
//         noStoreFetch（冷啟動時略過 HTTP 快取）、wasmPaths、remoteHost（自架來源，驗證用）。
export async function prepare(options = {}) {
  const { env, pipeline } = await loadLibrary(options.libraryUrl);
  const trace = (...a) => { if (options.trace) console.log('[bench]', Math.round(performance.now()), ...a); };
  trace('prepare start', JSON.stringify({ dtype: options.dtype, device: options.device, numThreads: options.numThreads }));
  const dtype = options.dtype || 'fp16';
  const device = options.device || 'webgpu';

  if (typeof options.numThreads === 'number') env.backends.onnx.wasm.numThreads = options.numThreads;
  // 自架 WebAssembly 檔（離線或本機驗證用）；未指定時沿用函式庫預設的 jsdelivr 網址
  if (options.wasmPaths) env.backends.onnx.wasm.wasmPaths = options.wasmPaths;
  // 自架模型伺服器（本機驗證用）；未指定時沿用 Hugging Face
  if (options.remoteHost) env.remoteHost = options.remoteHost;

  // 冷啟動：讓模型檔與 WebAssembly 檔都略過 HTTP 快取，模擬首次造訪。
  // 暖啟動不重新下載（改由 Cache Storage 提供），所以不需要包裝。
  if (options.noStoreFetch && !env.__benchWrappedFetch) {
    const original = env.fetch;
    env.fetch = (input, init = {}) => original(input, { ...init, cache: 'no-store' });
    env.__benchWrappedFetch = true;
  }

  // 準備前的快取筆數：冷啟動應為 0；暖啟動應大於 0
  let cacheEntriesBefore = null;
  try {
    const cache = await caches.open(env.cacheKey);
    cacheEntriesBefore = (await cache.keys()).length;
  } catch { /* 忽略 */ }

  // 函式庫讀到的位元組數（含從快取讀取的部分，所以不等於下載量，只在快取為空時才可當下載量參考）
  const perFile = new Map();
  libraryBytes = 0;
  classifier = await pipeline('sentiment-analysis', MODEL_ID, {
    device,
    dtype,
    progress_callback: (e) => {
      if (e && e.status === 'progress' && typeof e.loaded === 'number') perFile.set(e.file, e.loaded);
      if (e && (e.status === 'initiate' || e.status === 'done' || e.status === 'ready')) trace('progress', e.status, e.file || '');
    },
  });
  trace('pipeline ready');
  for (const v of perFile.values()) libraryBytes += v;

  let ortVersion = null;
  try { ortVersion = env.backends.onnx.versions?.web ?? null; } catch { /* 忽略 */ }
  let threads = null;
  try { threads = env.backends.onnx.wasm.numThreads ?? null; } catch { /* 忽略 */ }

  return {
    dtype, device, libraryVersion: LIBRARY_VERSION, ortVersion, numThreads: threads,
    cacheEntriesBefore, libraryBytes, files: Object.fromEntries(perFile),
  };
}

export async function classify(text) {
  if (!classifier) throw new Error('分類器尚未建立');
  const out = await classifier(text);
  const first = Array.isArray(out) ? out[0] : out;
  return { label: first.label, score: first.score };
}

export async function dispose() {
  try { await classifier?.dispose?.(); } finally { classifier = null; }
}

export { resourceBytes };
