// 任務 A（情緒分類）：Transformers.js 4.3.1 + DistilBERT SST-2。
// 進階選項（JSON）：
//   dtype       fp16（預設）、int8、fp32
//   device      webgpu（預設）、wasm
//   numThreads  整數，只影響 wasm（例如 1 為單執行緒對照）
//   libraryUrl  覆寫函式庫網址（本機驗證用）
//   wasmPaths   覆寫 WebAssembly 檔位置，格式 {"mjs":"…","wasm":"…"}（本機驗證用）
//   remoteHost  覆寫模型來源，預設 Hugging Face（本機驗證用）
//   expectedBytes  覆寫冷啟動檢查的預期模型大小（本機驗證用）
//   dataset     sst2 時改用本機 SST-2 驗證集（見 getInputs）
//   trace       true 時把準備階段的步驟輸出到主控台（除錯用，不影響量測）
import { createWorkerProxy, loadSentences, resourceBytes } from '../bench.js';
import { prepare, classify, dispose, loadLibrary, cacheStorageBytes, EXPECTED_BYTES } from './transformers-core.js';

const ALLOWED_DTYPE = ['fp32', 'fp16', 'int8'];
const ALLOWED_DEVICE = ['webgpu', 'wasm'];

function normalize(ctx) {
  const o = ctx.options || {};
  const dtype = o.dtype || 'fp16';
  const device = o.device || 'webgpu';
  if (!ALLOWED_DTYPE.includes(dtype)) throw new Error(`dtype 不支援：${dtype}（可用：${ALLOWED_DTYPE.join('、')}）`);
  if (!ALLOWED_DEVICE.includes(device)) throw new Error(`device 不支援：${device}（可用：${ALLOWED_DEVICE.join('、')}）`);
  if (o.numThreads !== undefined && !(Number.isInteger(o.numThreads) && o.numThreads >= 1 && o.numThreads <= 32)) {
    throw new Error('numThreads 必須是 1 到 32 的整數');
  }
  return {
    dtype, device, numThreads: o.numThreads, libraryUrl: o.libraryUrl,
    wasmPaths: o.wasmPaths, remoteHost: o.remoteHost, trace: o.trace === true,
    noStoreFetch: ctx.phase === 'cold', // 冷啟動略過 HTTP 快取
  };
}

export default {
  id: 'transformers-distilbert',
  label: '任務 A：Transformers.js + DistilBERT',
  task: 'sentiment',
  kind: 'classify',
  modes: ['main', 'worker'],
  // 預設 fp16；選其他 dtype 時由 expectedBytesFor 取代
  expectedModelBytes: EXPECTED_BYTES.fp16,
  expectedBytesFor(options) {
    if (options && typeof options.expectedBytes === 'number') return options.expectedBytes;
    return EXPECTED_BYTES[(options && options.dtype) || 'fp16'];
  },

  // dataset: "sst2" 時改讀本機的 SST-2 驗證集（../data/sst2-validation.json，不納入版本紀錄；
  // 只能從本機伺服器開啟量測頁時使用）。每輪推論次數請設為 872 以涵蓋全部句子。
  async getInputs(ctx) {
    const o = (ctx && ctx.options) || {};
    if (o.dataset === 'sst2') {
      const res = await fetch(new URL('../../data/sst2-validation.json', import.meta.url), { cache: 'no-store' });
      if (!res.ok) throw new Error('找不到 data/sst2-validation.json（此檔只存在於本機，請從本機伺服器開啟量測頁）');
      const { items } = await res.json();
      return { inputs: items.map((x) => x.text), labels: items.map((x) => x.label) };
    }
    const { inputs, labels } = await loadSentences();
    return { inputs, labels };
  },

  // 函式庫載入與 Worker 建立不計入準備時間
  async load(ctx) {
    ctx.shared.cfg = normalize(ctx);
    if (ctx.mode === 'worker') {
      ctx.shared.proxy = createWorkerProxy(new URL('./transformers-worker.js', import.meta.url));
      await ctx.shared.proxy.call('load', { libraryUrl: ctx.shared.cfg.libraryUrl });
    } else {
      await loadLibrary(ctx.shared.cfg.libraryUrl);
    }
  },

  async create(ctx) {
    const cfg = ctx.shared.cfg;
    const info = ctx.mode === 'worker' ? await ctx.shared.proxy.call('prepare', cfg) : await prepare(cfg);
    return { proxy: ctx.shared.proxy || null, info };
  },

  async infer(handle, text) {
    return handle.proxy ? handle.proxy.call('classify', text) : classify(text);
  },

  summarizeOutput(out) { return `${out.label} ${out.score.toFixed(4)}`; },
  labelOf(out) { return out.label; },

  // Worker 的資源紀錄不會出現在主執行緒，所以由 Worker 自己回報；再併入準備階段的函式庫回報資訊
  async getTransferBytes(handle, sinceEpochMs) {
    const rt = handle.proxy ? await handle.proxy.call('__resourceBytes__', { sinceEpochMs }) : resourceBytes(sinceEpochMs);
    const { cacheEntriesBefore, libraryBytes, dtype, device, numThreads, libraryVersion, ortVersion } = handle.info;
    const cs = handle.proxy ? await handle.proxy.call('cacheBytes') : await cacheStorageBytes();
    return { ...rt, cacheStorageBytes: cs.total, cacheStorageFiles: cs.files, cacheEntriesBefore, libraryBytes, config: { dtype, device, numThreads, libraryVersion, ortVersion } };
  },

  async dispose(handle) {
    try {
      if (handle.proxy) await handle.proxy.call('dispose');
      else await dispose();
    } finally {
      handle.proxy?.terminate();
    }
  },
};
