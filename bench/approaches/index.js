// 受測方案登錄表。新增方案時在此加入一行，並依 bench.js 的 runRound 說明實作介面。
export const APPROACHES = {
  selftest: { label: '框架自我檢查（模擬方案）', load: () => import('./selftest.js') },
};
