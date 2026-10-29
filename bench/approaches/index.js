// 受測方案登錄表。新增方案時在此加入一行，並依 bench.js 的 runRound 說明實作介面。
export const APPROACHES = {
  'transformers-distilbert': { label: '任務 A：Transformers.js + DistilBERT', load: () => import('./transformers-distilbert.js') },
  selftest: { label: '框架自我檢查（模擬方案）', load: () => import('./selftest.js') },
};
