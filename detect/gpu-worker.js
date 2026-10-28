// 在 Web Worker 中檢查 WebGPU 是否可用，結果以 postMessage 回傳主執行緒。
self.onmessage = async () => {
  const r = { workerGpu: 'gpu' in self.navigator };
  try {
    if (r.workerGpu) {
      const adapter = await self.navigator.gpu.requestAdapter();
      r.adapter = !!adapter;
      if (adapter) {
        r.shaderF16 = adapter.features.has('shader-f16');
        const info = adapter.info || {};
        r.vendor = info.vendor || '';
        r.architecture = info.architecture || '';
      }
    }
  } catch (e) {
    r.error = String(e && e.message || e);
  }
  self.postMessage(r);
};
