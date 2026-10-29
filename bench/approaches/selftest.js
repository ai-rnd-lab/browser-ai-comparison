// 框架自我檢查（模擬方案）。介面說明見 bench.js 的 runRound。
import { createWorkerProxy, resourceBytes } from '../bench.js';
import { prepareModel, classify } from './selftest-core.js';

export default {
  id: 'selftest',
  label: '框架自我檢查（模擬方案）',
  task: 'selftest',
  kind: 'classify',
  modes: ['main', 'worker'],
  expectedModelBytes: 5000,
  // 推論的忙碌時間需明顯大於心跳間隔（16 ms），主執行緒阻塞才量得到
  defaultInputs: [{ busyMs: 40 }, { busyMs: 60 }, { busyMs: 50 }],

  // Worker 的建立與載入不計入 M2／M3，與「函式庫載入不計入」的規則一致
  async load(ctx) {
    if (ctx.mode === 'worker') {
      ctx.shared.proxy = createWorkerProxy(new URL('./selftest-worker.js', import.meta.url));
      await ctx.shared.proxy.call('load');
    }
  },
  async create(ctx) {
    const args = { blockMs: 100, downloadUrl: ctx.options.downloadUrl || null };
    if (ctx.mode === 'worker') {
      await ctx.shared.proxy.call('prepare', args);
      return { proxy: ctx.shared.proxy };
    }
    await prepareModel(args);
    return { proxy: null };
  },
  async infer(handle, input) {
    return handle.proxy ? handle.proxy.call('classify', input) : classify(input);
  },
  async getTransferBytes(handle, sinceEpochMs) {
    return handle.proxy ? handle.proxy.call('__resourceBytes__', { sinceEpochMs }) : resourceBytes(sinceEpochMs);
  },
  async dispose(handle) {
    handle.proxy?.terminate();
  },
};
