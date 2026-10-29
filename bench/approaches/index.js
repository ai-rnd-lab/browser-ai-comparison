// 受測方案登錄表。新增方案時在此加入一行，並依 bench.js 的 runRound 說明實作介面。
export const APPROACHES = {
  'transformers-distilbert': { label: '任務 A：Transformers.js + DistilBERT', load: () => import('./transformers-distilbert.js') },
  'ort-distilbert': { label: '任務 A：ONNX Runtime Web 直接呼叫 + DistilBERT', load: () => import('./ort-distilbert.js') },
  'litert-classifier': { label: '任務 A：LiteRT.js 最小檢查（MobileBERT）', load: () => import('./litert-classifier.js') },
  selftest: { label: '框架自我檢查（模擬方案）', load: () => import('./selftest.js') },
};
