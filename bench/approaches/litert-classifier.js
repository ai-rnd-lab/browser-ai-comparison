// 任務 A（情緒分類）：LiteRT.js 最小檢查（MediaPipe BERT 分類模型 = MobileBERT，SST-2 訓練）。
// 與 DistilBERT 不是同一個模型，只確認 LiteRT.js 能否在瀏覽器跑 BERT 類文字分類，不做同模型比較。
// 進階選項（JSON）：
//   device      webgpu（預設）、wasm
//   threads     true 時載入多執行緒版 WebAssembly（需跨來源隔離），預設 false
//   modelUrl    覆寫 .tflite 來源，預設 Google 的 MediaPipe 模型網址（本機驗證用）
//   libraryUrl / wasmDir  覆寫 LiteRT.js 與其 WebAssembly 資料夾位置（本機驗證用）
//   dataset     sst2 時改用本機 SST-2 驗證集（見 getInputs）
import { createWorkerProxy, loadSentences, resourceBytes } from '../bench.js';
import { prepare, classify, dispose, loadLibrary, cacheStorageBytes } from './litert-core.js';

const ALLOWED_DEVICE = ['webgpu', 'wasm'];

function normalize(ctx) {
  const o = ctx.options || {};
  const device = o.device || 'webgpu';
  if (!ALLOWED_DEVICE.includes(device)) throw new Error(`device 不支援：${device}（可用：${ALLOWED_DEVICE.join('、')}）`);
  return {
    accelerator: device, threads: o.threads === true, modelUrl: o.modelUrl, libraryUrl: o.libraryUrl, wasmDir: o.wasmDir,
    noStoreFetch: ctx.phase === 'cold', // 冷啟動略過 HTTP 快取（只影響 .tflite；LiteRT 的 WebAssembly 由函式庫自行載入）
  };
}

export default {
  id: 'litert-classifier',
  label: '任務 A：LiteRT.js 最小檢查（MobileBERT）',
  task: 'sentiment',
  kind: 'classify',
  // 只支援主執行緒：LiteRT.js 4.x 以前的載入程式在 Worker 內呼叫 importScripts，module Worker 不支援。
  modes: ['main'],
  // 模型大小未知（官方文件未提供），因此不設預期大小；冷啟動檢查回報 no-expectation。

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
      ctx.shared.proxy = createWorkerProxy(new URL('./litert-worker.js', import.meta.url));
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
    const { cacheEntriesBefore, libraryBytes, device, numThreads, libraryVersion, ortVersion } = handle.info;
    const dtype = 'model-defined';
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
